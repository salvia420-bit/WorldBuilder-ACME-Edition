var xt = Object.defineProperty;
var pt = (l, n, t) => n in l ? xt(l, n, { enumerable: !0, configurable: !0, writable: !0, value: t }) : l[n] = t;
var d = (l, n, t) => pt(l, typeof n != "symbol" ? n + "" : n, t);
import * as b from "three";
import { Vector2 as z, Vector3 as y, Box3 as st } from "three";
class yt {
  constructor() {
    /**
     * Scale factor to apply to texture coordinates.
     */
    d(this, "textureScale");
    /**
     * Offset to apply to texture coordinates.
     */
    d(this, "textureOffset");
    this.textureScale = new z(1, 1), this.textureOffset = new z();
  }
}
class G {
  /**
   * Generates uniformly distributed random seed points within a bounding box
   * @param bounds The bounding box to generate seeds within
   * @param count Number of seed points to generate
   * @param rng Optional seeded random number generator. If not provided, Math.random() is used
   * @returns Array of seed points
   */
  static generateUniform(n, t, i) {
    const o = [], s = n.min, e = n.max, r = i ? () => i.random() : () => Math.random();
    for (let h = 0; h < t; h++)
      o.push(
        new y(
          s.x + r() * (e.x - s.x),
          s.y + r() * (e.y - s.y),
          s.z + r() * (e.z - s.z)
        )
      );
    return o;
  }
  /**
   * Generates seed points with higher density near an impact point
   * Uses a hybrid approach: some seeds clustered near impact, others uniform
   * @param bounds The bounding box to generate seeds within
   * @param count Number of seed points to generate
   * @param impactPoint The point of impact
   * @param impactRadius Radius around impact point where density is highest
   * @param rng Optional seeded random number generator. If not provided, Math.random() is used
   * @returns Array of seed points
   */
  static generateImpactBased(n, t, i, o, s) {
    const e = [], r = s ? () => s.random() : () => Math.random(), h = new y(
      Math.max(n.min.x, Math.min(n.max.x, i.x)),
      Math.max(n.min.y, Math.min(n.max.y, i.y)),
      Math.max(n.min.z, Math.min(n.max.z, i.z))
    ), a = Math.floor(t * 0.6), c = t - a;
    for (let g = 0; g < a; g++) {
      const u = Math.pow(r(), 2) * o, f = r() * 2 * Math.PI, x = Math.acos(2 * r() - 1), p = h.x + u * Math.sin(x) * Math.cos(f), I = h.y + u * Math.sin(x) * Math.sin(f), O = h.z + u * Math.cos(x);
      e.push(
        new y(
          Math.max(n.min.x, Math.min(n.max.x, p)),
          Math.max(n.min.y, Math.min(n.max.y, I)),
          Math.max(n.min.z, Math.min(n.max.z, O))
        )
      );
    }
    return e.push(...this.generateUniform(n, c, s)), e;
  }
  /**
   * Generates seed points for 2.5D Voronoi fracturing
   * Creates a 2D pattern in one plane and extrudes through the mesh
   * @param bounds The bounding box to generate seeds within
   * @param count Number of seed points to generate
   * @param axis The axis along which to generate the pattern ('x', 'y', or 'z')
   * @param rng Optional seeded random number generator. If not provided, Math.random() is used
   * @returns Array of seed points in 3D space
   */
  static generate2D(n, t, i, o) {
    const s = [], e = n.min, r = n.max, h = new y(
      (e.x + r.x) / 2,
      (e.y + r.y) / 2,
      (e.z + r.z) / 2
    ), a = o ? () => o.random() : () => Math.random();
    for (let c = 0; c < t; c++) {
      let g;
      i === "x" ? g = new y(
        h.x,
        e.y + a() * (r.y - e.y),
        e.z + a() * (r.z - e.z)
      ) : i === "y" ? g = new y(
        e.x + a() * (r.x - e.x),
        h.y,
        e.z + a() * (r.z - e.z)
      ) : g = new y(
        e.x + a() * (r.x - e.x),
        e.y + a() * (r.y - e.y),
        h.z
      ), s.push(g);
    }
    return s;
  }
  /**
   * Generates 2D seed points with higher density near an impact point
   * Seeds remain on a plane (for 2.5D mode) but cluster around impact
   * @param bounds The bounding box to generate seeds within
   * @param count Number of seed points to generate
   * @param impactPoint The point of impact
   * @param impactRadius Radius around impact point where density is highest
   * @param axis The axis along which to generate the pattern ('x', 'y', or 'z')
   * @param rng Optional seeded random number generator. If not provided, Math.random() is used
   * @returns Array of seed points on the specified plane
   */
  static generate2DImpactBased(n, t, i, o, s, e) {
    const r = [], h = n.min, a = n.max, c = new y(
      (h.x + a.x) / 2,
      (h.y + a.y) / 2,
      (h.z + a.z) / 2
    ), g = e ? () => e.random() : () => Math.random();
    let u;
    s === "x" ? u = new y(c.x, i.y, i.z) : s === "y" ? u = new y(i.x, c.y, i.z) : u = new y(i.x, i.y, c.z);
    const f = Math.floor(t * 0.6), x = t - f;
    for (let p = 0; p < f; p++) {
      const I = Math.pow(g(), 2) * o, O = g() * 2 * Math.PI;
      let _;
      if (s === "x") {
        const j = u.y + I * Math.cos(O), P = u.z + I * Math.sin(O);
        _ = new y(
          c.x,
          Math.max(h.y, Math.min(a.y, j)),
          Math.max(h.z, Math.min(a.z, P))
        );
      } else if (s === "y") {
        const j = u.x + I * Math.cos(O), P = u.z + I * Math.sin(O);
        _ = new y(
          Math.max(h.x, Math.min(a.x, j)),
          c.y,
          Math.max(h.z, Math.min(a.z, P))
        );
      } else {
        const j = u.x + I * Math.cos(O), P = u.y + I * Math.sin(O);
        _ = new y(
          Math.max(h.x, Math.min(a.x, j)),
          Math.max(h.y, Math.min(a.y, P)),
          c.z
        );
      }
      r.push(_);
    }
    return r.push(...this.generate2D(n, x, s, e)), r;
  }
  /**
   * Automatically determines the best projection axis for 2.5D mode
   * based on mesh dimensions (chooses the shortest dimension)
   * @param bounds The bounding box of the mesh
   * @returns The axis perpendicular to the largest face
   */
  static determineBestProjectionAxis(n) {
    const t = new y(
      n.max.x - n.min.x,
      n.max.y - n.min.y,
      n.max.z - n.min.z
    );
    return t.x <= t.y && t.x <= t.z ? "x" : t.y <= t.x && t.y <= t.z ? "y" : "z";
  }
}
function D(l, n, t, i) {
  return mt(l, n, t, i, !1);
}
function mt(l, n, t, i, o) {
  let s = { x: n.x - l.x, y: n.y - l.y }, e = { x: i.x - t.x, y: i.y - t.y };
  const r = H(l), h = H(t);
  if (r === h) return o;
  const a = H(n);
  if (a === h) return o;
  const c = H(i);
  if (r === c || a === c) return o;
  let g = (l.x - t.x) * e.y - (l.y - t.y) * e.x, u = (n.x - t.x) * e.y - (n.y - t.y) * e.x, f = (t.x - l.x) * s.y - (t.y - l.y) * s.x, x = (i.x - l.x) * s.y - (i.y - l.y) * s.x;
  return (g >= 0 && u <= 0 || g <= 0 && u >= 0) && (f >= 0 && x <= 0 || f <= 0 && x >= 0);
}
function rt(l, n, t, i) {
  let o = 0, s = new y();
  return Q(l) === Q(n) || t.x === 0 && t.y === 0 && t.z === 0 ? null : (o = ((i.x - l.x) * t.x + (i.y - l.y) * t.y + (i.z - l.z) * t.z) / ((n.x - l.x) * t.x + (n.y - l.y) * t.y + (n.z - l.z) * t.z), o >= 0 && o <= 1 ? (s = new y(
    l.x + (n.x - l.x) * o,
    l.y + (n.y - l.y) * o,
    l.z + (n.z - l.z) * o
  ), { x: s, s: o }) : null);
}
function S(l, n, t) {
  return (n.x - l.x) * (t.y - l.y) - (n.y - l.y) * (t.x - l.x) <= 0;
}
function F(l, n) {
  return Math.round(0.5 * ((l + n) * (l + n + 1)) + n);
}
function H(l, n = 1e-9) {
  const t = 1 / n, i = Math.floor(l.x * t), o = Math.floor(l.y * t);
  return F(i, o);
}
function Q(l, n = 1e-9) {
  const t = 1 / n, i = Math.floor(l.x * t), o = Math.floor(l.y * t), s = Math.floor(l.z * t), e = 0.5 * ((i + o) * (i + o + 1)) + o;
  return 0.5 * ((e + s) * (e + s + 1)) + s;
}
function ot(l, n, t) {
  return n.x * (l.x - t.x) + n.y * (l.y - t.y) + n.z * (l.z - t.z) >= 0;
}
class U {
  constructor(n = new y(), t = new y(), i = new z()) {
    d(this, "position");
    d(this, "normal");
    d(this, "uv");
    this.position = n, this.normal = t, this.uv = i;
  }
  /**
   * Returns true if this vertex and another vertex share the same position
   * @param other
   * @returns
   */
  equals(n) {
    return Q(this.position) === Q(n.position);
  }
  /**
   * Creates a deep copy of this vertex
   * @returns A new MeshVertex with cloned position, normal, and UV
   */
  clone() {
    return new U(
      this.position.clone(),
      this.normal.clone(),
      this.uv.clone()
    );
  }
  toString() {
    return `Position = ${this.position.x}, ${this.position.y}, ${this.position.z}, Normal = ${this.normal.x}, ${this.normal.y}, ${this.normal.z}, UV = ${this.uv.x}, ${this.uv.y}`;
  }
}
var K = /* @__PURE__ */ ((l) => (l[l.Default = 0] = "Default", l[l.CutFace = 1] = "CutFace", l))(K || {});
class X {
  /**
   * Constructor for a Fragment object
   * @param args The arguments for the Fragment object
   */
  constructor(n = void 0) {
    /**
     * Array of vertices for geometry on the non-cut faces
     */
    d(this, "vertices");
    /**
     * Array of vertices for geometry on the cut faces
     */
    d(this, "cutVertices");
    /**
     * Index buffer for each submesh
     */
    d(this, "triangles");
    /**
     * List of edges constraints for the cut-face triangulation
     */
    d(this, "constraints");
    /**
     * Map between vertex indices in the source mesh and new indices for the sliced mesh
     */
    d(this, "indexMap");
    /**
     * The bounds of the vertex data (must manually call UpdateBounds() to update)
     */
    d(this, "bounds");
    /**
     * Tracks which vertex a cut-face vertex maps. This is used for during the island
     * detection algorithm to connect non-cut-face geometry to the cut-face geometry.
     */
    d(this, "vertexAdjacency");
    if (this.vertices = [], this.cutVertices = [], this.triangles = [[], []], this.constraints = [], this.indexMap = [], this.bounds = new st(), this.vertexAdjacency = [], !n)
      return;
    const { positions: t, normals: i, uvs: o, indices: s } = n;
    for (let e = 0; e < t.length / 3; e++) {
      const r = new y(
        t[3 * e],
        t[3 * e + 1],
        t[3 * e + 2]
      ), h = new y(
        i[3 * e],
        i[3 * e + 1],
        i[3 * e + 2]
      ), a = o ? new z(o[2 * e], o[2 * e + 1]) : new z(0, 0);
      this.vertices.push(new U(r, h, a));
    }
    if (s)
      this.triangles = [Array.from(s), []];
    else {
      const e = t.length / 3;
      this.triangles = [Array.from({ length: e }, (r, h) => h), []];
    }
    this.calculateBounds();
  }
  /**
   * Gets the total number of triangles across all sub meshes
   */
  get triangleCount() {
    return (this.triangles[0].length + this.triangles[1].length) / 3;
  }
  /**
   * Gets the total number of vertices in the geometry
   */
  get vertexCount() {
    return this.vertices.length + this.cutVertices.length;
  }
  /**
   * Adds a new cut face vertex
   * @param position The vertex position
   * @param normal The vertex normal
   * @param uv The vertex UV coordinates
   */
  addCutFaceVertex(n, t, i) {
    const o = new U(n, t, i);
    this.vertices.push(o), this.cutVertices.push(o), this.vertexAdjacency.push(this.vertices.length - 1);
  }
  /**
   * Adds a new vertex to this mesh that is mapped to the source mesh
   * @param vertex Vertex data
   * @param sourceIndex Index of the vertex in the source mesh
   */
  addMappedVertex(n, t) {
    this.vertices.push(n), this.indexMap[t] = this.vertices.length - 1;
  }
  /**
   * Adds a new triangle to this mesh. The arguments v1, v2, v3 are the indexes of the
   * vertices relative to this mesh's list of vertices; no mapping is performed.
   * @param v1 Index of the first vertex
   * @param v2 Index of the second vertex
   * @param v3 Index of the third vertex
   * @param subMesh The sub-mesh to add the triangle to
   */
  addTriangle(n, t, i, o) {
    this.triangles[o].push(n, t, i);
  }
  /**
   * Adds a new triangle to this mesh. The arguments v1, v2, v3 are the indices of the
   * vertices in the original mesh. These vertices are mapped to the indices in the sliced mesh.
   * @param v1 Index of the first vertex
   * @param v2 Index of the second vertex
   * @param v3 Index of the third vertex
   * @param subMesh The sub-mesh to add the triangle to
   */
  addMappedTriangle(n, t, i, o) {
    this.triangles[o].push(
      this.indexMap[n],
      this.indexMap[t],
      this.indexMap[i]
    );
  }
  /**
   * Finds coincident vertices on the cut face and welds them together
   */
  weldCutFaceVertices() {
    const n = [], t = [], i = new Array(this.cutVertices.length);
    let o = 0;
    const s = /* @__PURE__ */ new Map();
    this.cutVertices.forEach((r, h) => {
      const a = Q(r.position);
      s.has(a) ? i[h] = s.get(a) : (i[h] = o, s.set(a, o), n.push(this.cutVertices[h]), t.push(this.vertexAdjacency[h]), o++);
    });
    const e = [];
    for (let r = 0; r < this.constraints.length; r++) {
      const h = this.constraints[r];
      h.v1 = i[h.v1], h.v2 = i[h.v2], !(Math.abs(h.v1 - h.v2) < 1e-9) && e.push(h);
    }
    this.constraints = e, this.cutVertices = n, this.vertexAdjacency = t;
  }
  /**
   * Calculates the bounds of the mesh data
   */
  calculateBounds() {
    let n = this.vertices[0].position.clone(), t = n.clone();
    this.vertices.forEach((i) => {
      n.x = Math.min(n.x, i.position.x), n.y = Math.min(n.y, i.position.y), n.z = Math.min(n.z, i.position.z), t.x = Math.max(t.x, i.position.x), t.y = Math.max(t.y, i.position.y), t.z = Math.max(t.z, i.position.z);
    }), this.bounds = new st(n, t);
  }
}
class k {
  /**
   * Creates a new edge constraint with the given end points
   */
  constructor(n, t, i, o, s) {
    /**
     * Index of the first end point of the constraint
     */
    d(this, "v1");
    /**
     * Index of the second end point of the constraint
     */
    d(this, "v2");
    /**
     * Index of the triangle prior to the edge crossing (v1 -> v2)
     */
    d(this, "t1");
    /**
     * Index of the triangle after the edge crossing (v1 -> v2)
     */
    d(this, "t2");
    /**
     * Index of the edge on the t1 side
     */
    d(this, "t1Edge");
    this.v1 = n, this.v2 = t, this.t1 = i ?? -1, this.t2 = o ?? -1, this.t1Edge = s ?? 0;
  }
  /**
   * Determines whether the specified object is equal to the current object
   */
  equals(n) {
    return this.v1 === n.v1 && this.v2 === n.v2 || this.v1 === n.v2 && this.v2 === n.v1;
  }
  /**
   * Creates a copy of this edge constraint
   */
  clone() {
    return new k(this.v1, this.v2, this.t1, this.t2, this.t1Edge);
  }
  /**
   * Returns a string that represents the current object
   */
  toString() {
    return `Edge: T${this.t1}->T${this.t2} (V${this.v1}->V${this.v2})`;
  }
}
class Y {
  /**
   * Instantiates a new triangulation point
   * @param index The index of the point in the original point list
   * @param coords The 2D coordinates of the point in the triangulation plane
   */
  constructor(n, t) {
    /**
     * 2D coordinates of the point on the triangulation plane
     */
    d(this, "coords");
    /**
     * Bin used for sorting points in grid
     */
    d(this, "bin");
    /**
     * Original index prior to sorting
     */
    d(this, "index");
    this.index = n, this.coords = t, this.bin = 0;
  }
  toString() {
    return `${this.coords} -> ${this.bin}`;
  }
}
class at {
  /**
   * Computes the bin number for the set of grid coordinates.
   *
   * @param i - Grid row
   * @param j - Grid column
   * @param n - Grid size
   * @returns The computed bin number based on row and column indices.
   */
  static getBinNumber(n, t, i) {
    return n % 2 === 0 ? n * i + t : (n + 1) * i - t - 1;
  }
  /**
   * Performs a counting sort of the input points based on their bin number. Only
   * sorts the elements in the index range [0, count]. If binCount is <= 1, no sorting
   * is performed. If lastIndex > input.length, the entire input array is sorted.
   *
   * @param input - The input array to sort
   * @param lastIndex - The index of the last element in `input` to sort. Only the
   * elements [0, lastIndex) are sorted.
   * @param binCount - Number of bins
   * @returns The sorted array of points based on their bin number.
   */
  static sort(n, t, i) {
    if (i <= 1)
      return n;
    t > n.length && (t = n.length);
    const o = new Array(i).fill(0), s = new Array(n.length);
    for (let e = 0; e < t; e++)
      o[n[e].bin]++;
    for (let e = 1; e < i; e++)
      o[e] += o[e - 1];
    for (let e = t - 1; e >= 0; e--) {
      const r = n[e].bin;
      o[r]--, s[o[r]] = n[e];
    }
    for (let e = t; e < s.length; e++)
      s[e] = n[e];
    return s;
  }
}
const V = 0, A = 1, T = 2, q = 3, M = 4, C = 5, R = 0, $ = -1;
class ht {
  /**
   * Initializes the triangulator with the vertex data to be triangulated
   *
   * @param inputPoints The points to triangulate
   * @param normal The normal of the triangulation plane
   */
  constructor(n, t) {
    /**
     * Number of points to be triangulated (excluding super triangle vertices)
     */
    d(this, "N");
    /**
     * Total number of triangles generated during triangulation
     */
    d(this, "triangleCount");
    /**
     * Triangle vertex and adjacency data
     * Index 0 = Triangle index
     * Index 1 = [V1, V2, V3, E12, E23, E32]
     */
    d(this, "triangulation");
    /**
     * Points on the plane to triangulate
     */
    d(this, "points");
    /**
     * Array which tracks which triangles should be ignored in the final triangulation
     */
    d(this, "skipTriangle");
    /**
     * Normal of the plane on which the points lie
     */
    d(this, "normal");
    /**
     * Normalization scale factor
     */
    d(this, "normalizationScaleFactor", 1);
    if (this.N = n.length, this.N >= 3) {
      this.triangleCount = 2 * this.N + 1, this.triangulation = Array.from(
        { length: this.triangleCount },
        () => new Array(6).fill(0)
      ), this.skipTriangle = new Array(this.triangleCount).fill(!1), this.points = new Array(this.N + 3), this.normal = t.clone().normalize();
      let s = n[0].position.clone().sub(n[1].position).normalize(), e = this.normal.clone(), r = new y();
      r.crossVectors(s, e).normalize();
      for (let h = 0; h < this.N; h++) {
        var i = n[h].position, o = new z(i.dot(s), i.dot(r));
        this.points[h] = new Y(h, o);
      }
    } else
      this.triangleCount = 0, this.triangulation = [], this.skipTriangle = [], this.points = [], this.normal = new y();
  }
  /**
   * Performs the triangulation
   *
   * @returns Returns an array containing the indices of the triangles, mapped to the list of points passed in during initialization
   */
  triangulate() {
    if (this.N < 3)
      return [];
    this.addSuperTriangle(), this.normalizeCoordinates(), this.computeTriangulation(), this.discardTrianglesWithSuperTriangleVertices();
    const n = [];
    for (let t = 0; t < this.triangleCount; t++)
      this.skipTriangle[t] || n.push(
        this.triangulation[t][V],
        this.triangulation[t][A],
        this.triangulation[t][T]
      );
    return n;
  }
  /**
   * Uniformly scales the 2D coordinates of all the points between [0, 1]
   */
  normalizeCoordinates() {
    let n = Number.MAX_VALUE, t = Number.MIN_VALUE, i = Number.MAX_VALUE, o = Number.MIN_VALUE;
    for (let h = 0; h < this.N; h++)
      n = Math.min(n, this.points[h].coords.x), t = Math.max(t, this.points[h].coords.x), i = Math.min(i, this.points[h].coords.y), o = Math.max(o, this.points[h].coords.y);
    const s = Math.max(t - n, o - i);
    for (let h = 0; h < this.N; h++) {
      var e = this.points[h], r = new z(
        (e.coords.x - n) / s,
        (e.coords.y - i) / s
      );
      this.points[h].coords = r;
    }
  }
  /**
   * Sorts the points into bins using an ordered grid
   *
   * @returns Returns the array of sorted points
   */
  sortPointsIntoBins() {
    const n = Math.round(Math.pow(this.N, 0.25)), t = n * n;
    for (let o = 0; o < this.N; o++) {
      var i = this.points[o];
      const s = Math.floor(0.99 * n * i.coords.y), e = Math.floor(0.99 * n * i.coords.x);
      i.bin = at.getBinNumber(s, e, n);
    }
    return at.sort(this.points, this.N, t);
  }
  /**
   * Computes the triangulation of the point set.
   * @returns Returns true if the triangulation was successful.
   */
  computeTriangulation() {
    let n = 0, t = 0, i = this.sortPointsIntoBins();
    for (let o = 0; o < this.N; o++) {
      let s = i[o], e = 0, r = !1;
      for (; !r && !(e++ > t || n === $); ) {
        let h = this.points[this.triangulation[n][V]].coords, a = this.points[this.triangulation[n][A]].coords, c = this.points[this.triangulation[n][T]].coords;
        S(h, a, s.coords) ? S(a, c, s.coords) ? S(c, h, s.coords) ? (this.insertPointIntoTriangle(s, n, t), t += 2, n = t, r = !0) : n = this.triangulation[n][C] : n = this.triangulation[n][M] : n = this.triangulation[n][q];
      }
    }
  }
  /**
   * Initializes the triangulation by inserting the super triangle
   */
  addSuperTriangle() {
    this.points[this.N] = new Y(
      this.N,
      new z(-100, -100)
    ), this.points[this.N + 1] = new Y(
      this.N + 1,
      new z(0, 100)
    ), this.points[this.N + 2] = new Y(
      this.N + 2,
      new z(100, -100)
    ), this.triangulation[R][V] = this.N, this.triangulation[R][A] = this.N + 1, this.triangulation[R][T] = this.N + 2, this.triangulation[R][q] = $, this.triangulation[R][M] = $, this.triangulation[R][C] = $;
  }
  /**
   * Inserts the point `p` into triangle `t`, replacing it with three new triangles
   *
   * @param p The index of the point to insert
   * @param t The index of the triangle
   * @param triangleCount Total number of triangles created so far
   */
  insertPointIntoTriangle(n, t, i) {
    const o = t, s = i + 1, e = i + 2;
    this.triangulation[s][V] = n.index, this.triangulation[s][A] = this.triangulation[t][A], this.triangulation[s][T] = this.triangulation[t][T], this.triangulation[s][q] = e, this.triangulation[s][M] = this.triangulation[t][M], this.triangulation[s][C] = o, this.triangulation[e][V] = n.index, this.triangulation[e][A] = this.triangulation[t][V], this.triangulation[e][T] = this.triangulation[t][A], this.triangulation[e][q] = o, this.triangulation[e][M] = this.triangulation[t][q], this.triangulation[e][C] = s, this.updateAdjacency(this.triangulation[t][q], t, e), this.updateAdjacency(this.triangulation[t][M], t, s), this.triangulation[o][A] = this.triangulation[t][T], this.triangulation[o][T] = this.triangulation[t][V], this.triangulation[o][V] = n.index, this.triangulation[o][M] = this.triangulation[t][C], this.triangulation[o][q] = s, this.triangulation[o][C] = e, this.restoreDelauneyTriangulation(n, o, s, e);
  }
  /**
   * Restores the triangulation to a Delauney triangulation after new triangles have been added.
   *
   * @param p Index of the inserted point
   * @param t1 Index of first triangle to check
   * @param t2 Index of second triangle to check
   * @param t3 Index of third triangle to check
   */
  restoreDelauneyTriangulation(n, t, i, o) {
    const s = [];
    for (s.push([t, this.triangulation[t][M]]), s.push([i, this.triangulation[i][M]]), s.push([o, this.triangulation[o][M]]); s.length > 0; )
      if ([t, i] = s.pop() ?? [$, $], i != $) {
        const e = this.swapQuadDiagonalIfNeeded(n.index, t, i);
        e && (s.push([t, e.t3]), s.push([i, e.t4]));
      }
  }
  /**
   * Swaps the diagonal of the quadrilateral formed by triangle `t` and the
   * triangle adjacent to the edge that is opposite of the newly added point
   *
   * @param p The index of the inserted point
   * @param t1 Index of the triangle containing p
   * @param t2 Index of the triangle opposite t1 that shares edge E23 with t1
   * @returns Returns an object containing
   *   - `t3`: Index of triangle adjacent to t1 after swap
   *   - `t4`: Index of triangle adjacent to t2 after swap
   */
  swapQuadDiagonalIfNeeded(n, t, i) {
    let o = 0, s = 0, e = 0, r = n, h = 0, a = 0;
    return this.triangulation[i][q] === t ? (o = this.triangulation[i][A], s = this.triangulation[i][V], e = this.triangulation[i][T], h = this.triangulation[i][M], a = this.triangulation[i][C]) : this.triangulation[i][M] === t ? (o = this.triangulation[i][T], s = this.triangulation[i][A], e = this.triangulation[i][V], h = this.triangulation[i][C], a = this.triangulation[i][q]) : (o = this.triangulation[i][V], s = this.triangulation[i][T], e = this.triangulation[i][A], h = this.triangulation[i][q], a = this.triangulation[i][M]), this.swapTest(
      this.points[o].coords,
      this.points[s].coords,
      this.points[e].coords,
      this.points[r].coords
    ) ? (this.updateAdjacency(h, i, t), this.updateAdjacency(this.triangulation[t][C], t, i), this.triangulation[t][V] = r, this.triangulation[t][A] = o, this.triangulation[t][T] = e, this.triangulation[i][V] = r, this.triangulation[i][A] = e, this.triangulation[i][T] = s, this.triangulation[i][q] = t, this.triangulation[i][M] = a, this.triangulation[i][C] = this.triangulation[t][C], this.triangulation[t][M] = h, this.triangulation[t][C] = i, { t3: h, t4: a }) : null;
  }
  /**
   * Marks any triangles that contain super-triangle vertices as discarded
   */
  discardTrianglesWithSuperTriangleVertices() {
    for (let n = 0; n < this.triangleCount; n++)
      (this.triangleContainsVertex(n, this.N) || this.triangleContainsVertex(n, this.N + 1) || this.triangleContainsVertex(n, this.N + 2)) && (this.skipTriangle[n] = !0);
  }
  /**
   * Checks to see if the triangle formed by points v1->v2->v3 circumscribes point v4.
   *
   * @param {Vector3} v1 - Coordinates of 1st vertex of triangle.
   * @param {Vector3} v2 - Coordinates of 2nd vertex of triangle.
   * @param {Vector3} v3 - Coordinates of 3rd vertex of triangle.
   * @param {Vector3} v4 - Coordinates of test point.
   * @returns {boolean} Returns true if the triangle formed by v1->v2->v3 circumscribes point v4.
   */
  swapTest(n, t, i, o) {
    const s = n.x - i.x, e = t.x - i.x, r = n.y - i.y, h = t.y - i.y, a = n.x - o.x, c = t.x - o.x, g = n.y - o.y, u = t.y - o.y, f = s * e + r * h, x = c * a + u * g;
    if (f >= 0 && x >= 0)
      return !1;
    if (f < 0 && x < 0)
      return !0;
    {
      const p = s * h - e * r, I = c * g - a * u;
      return p * x + I * f < 0;
    }
  }
  /**
   * Checks if the triangle `t` contains the specified vertex `v`.
   *
   * @param {number} t - The index of the triangle.
   * @param {number} v - The index of the vertex.
   * @returns {boolean} Returns true if the triangle `t` contains the vertex `v`.
   */
  triangleContainsVertex(n, t) {
    return this.triangulation[n][V] === t || this.triangulation[n][A] === t || this.triangulation[n][T] === t;
  }
  /**
   * Updates the adjacency information in triangle `t`. Any references to `tOld` are
   * replaced with `tNew`.
   *
   * @param {number} t - The index of the triangle to update.
   * @param {number} tOld - The index to be replaced.
   * @param {number} tNew - The new index to replace with.
   */
  updateAdjacency(n, t, i) {
    if (n === $)
      return;
    const o = this.findSharedEdge(n, t);
    o && (this.triangulation[n][o] = i);
  }
  /**
   * Finds the edge index for triangle `tOrigin` that is adjacent to triangle `tAdjacent`.
   *
   * @param {number} tOrigin - The origin triangle to search.
   * @param {number} tAdjacent - The triangle index to search for.
   * @param {number} edgeIndex - Edge index returned as an out parameter (by reference).
   * @returns {boolean} True if `tOrigin` is adjacent to `tAdjacent` and supplies the
   * shared edge index via the out parameter. False if `tOrigin` is an invalid index or
   * `tAdjacent` is not adjacent to `tOrigin`.
   */
  findSharedEdge(n, t) {
    return n === $ ? null : this.triangulation[n][q] === t ? q : this.triangulation[n][M] === t ? M : this.triangulation[n][C] === t ? C : null;
  }
}
class vt {
  constructor(n, t, i, o, s, e, r, h, a, c) {
    //               q3
    //      *---------*---------*
    //       \       / \       /
    //        \ t2L /   \ t2R /
    //         \   /     \   /
    //          \ /   t2  \ /
    //        q1 *---------* q2
    //          / \   t1  / \
    //         /   \     /   \
    //        / t1L \   / t1R \
    //       /       \ /       \
    //      *---------*---------*
    //               q4
    // The indices of the quad vertices
    d(this, "q1");
    d(this, "q2");
    d(this, "q3");
    d(this, "q4");
    // The triangles that make up the quad
    d(this, "t1");
    d(this, "t2");
    // Triangle adjacency data
    d(this, "t1L");
    d(this, "t1R");
    d(this, "t2L");
    d(this, "t2R");
    this.q1 = n, this.q2 = t, this.q3 = i, this.q4 = o, this.t1 = s, this.t2 = e, this.t1L = r, this.t1R = h, this.t2L = a, this.t2R = c;
  }
  toString() {
    return `T${this.t1}/T${this.t2} (V${this.q1},V${this.q2},V${this.q3},V${this.q4})`;
  }
}
const m = 0, v = 1, w = 2, B = 3, E = 4, N = 5, Z = -1;
class wt extends ht {
  /**
   * Initializes the triangulator with the vertex data to be triangulated given a set of edge constraints
   * @param inputPoints The of points to triangulate
   * @param constraints The list of edge constraints which defines how the vertices in `inputPoints` are connected.
   * @param normal The normal of the plane in which the `inputPoints` lie.
   */
  constructor(t, i, o) {
    super(t, o);
    /**
     * Given an edge E12, E23, E31, this returns the first vertex for that edge (V1, V2, V3, respectively)
     */
    d(this, "edgeVertex1", [0, 0, 0, m, v, w]);
    /**
     * Given an edge E12, E23, E31, this returns the second vertex for that edge (V2, V3, V1, respectively)
     */
    d(this, "edgeVertex2", [0, 0, 0, v, w, m]);
    /**
     * Given an edge E12, E23, E31, this returns the vertex opposite that edge (V3, V1, V2, respectively)
     */
    d(this, "oppositePoint", [0, 0, 0, w, m, v]);
    /**
     * Given an edge E12, E23, E31, this returns the next clockwise edge (E23, E31, E12, respectively)
     */
    d(this, "nextEdge", [0, 0, 0, E, N, B]);
    /**
     * Given an edge E12, E23, E31, this returns the previous clockwise edge (E31, E12, E23, respectively)
     */
    d(this, "previousEdge", [0, 0, 0, N, B, E]);
    /**
     * List of edge constraints provided during initialization
     */
    d(this, "constraints");
    /**
     * This array maps each vertex to a triangle in the triangulation that contains it. This helps
     * speed up the search when looking for intersecting edge. It isn't necessary to keep track of
     * every triangle for each vertex.
     */
    d(this, "vertexTriangles");
    this.constraints = i, this.vertexTriangles = [];
  }
  /**
   * Calculates the triangulation
   * @returns Returns an array containing the indices of the triangles, mapped to the list of points passed in during initialization.
   */
  triangulate() {
    if (this.N < 3)
      return [];
    this.addSuperTriangle(), this.normalizeCoordinates(), this.computeTriangulation(), this.constraints.length > 0 && (this.applyConstraints(), this.discardTrianglesViolatingConstraints()), this.discardTrianglesWithSuperTriangleVertices();
    let t = [];
    for (let i = 0; i < this.triangleCount; i++)
      this.skipTriangle[i] || (t.push(this.triangulation[i][m]), t.push(this.triangulation[i][v]), t.push(this.triangulation[i][w]));
    return t;
  }
  /**
   * Applys the edge constraints to the triangulation
   */
  applyConstraints() {
    this.vertexTriangles = new Array(this.N + 3).fill(0);
    for (let t = 0; t < this.triangulation.length; t++)
      this.vertexTriangles[this.triangulation[t][m]] = t, this.vertexTriangles[this.triangulation[t][v]] = t, this.vertexTriangles[this.triangulation[t][w]] = t;
    for (let t of this.constraints) {
      if (t.v1 === t.v2) continue;
      const i = this.findIntersectingEdges(
        t,
        this.vertexTriangles
      );
      this.removeIntersectingEdges(t, i);
    }
  }
  /**
   * Searches through the triangulation to find intersecting edges
   * @param constraint
   * @param vertexTriangles
   * @returns Array of edges that are intersecting
   */
  findIntersectingEdges(t, i) {
    const o = [], s = this.findStartingEdge(i, t);
    if (s)
      o.push(s);
    else
      return o;
    let e = s.t1, r = s.t1Edge, h = e, a = !1;
    for (; !a; ) {
      h = e, e = this.triangulation[e][r];
      const c = this.points[t.v1].coords, g = this.points[t.v2].coords, u = this.points[this.triangulation[e][m]].coords, f = this.points[this.triangulation[e][v]].coords, x = this.points[this.triangulation[e][w]].coords;
      if (this.triangleContainsVertex(e, t.v2))
        a = !0;
      else if (this.triangulation[e][B] !== h && D(c, g, u, f)) {
        r = B;
        const p = new k(
          this.triangulation[e][m],
          this.triangulation[e][v],
          e,
          this.triangulation[e][B],
          r
        );
        o.push(p);
      } else if (this.triangulation[e][E] !== h && D(c, g, f, x)) {
        r = E;
        const p = new k(
          this.triangulation[e][v],
          this.triangulation[e][w],
          e,
          this.triangulation[e][E],
          r
        );
        o.push(p);
      } else if (this.triangulation[e][N] !== h && D(c, g, x, u)) {
        r = N;
        const p = new k(
          this.triangulation[e][w],
          this.triangulation[e][m],
          e,
          this.triangulation[e][N],
          r
        );
        o.push(p);
      } else {
        console.warn("Failed to find final triangle, exiting early.");
        break;
      }
    }
    return o;
  }
  /**
   * Finds the starting edge for the search to find all edges that intersect the constraint
   * @param vertexTriangles
   * @param constraint The constraint being used to check for intersections
   * @param startingEdge
   * @returns
   */
  findStartingEdge(t, i) {
    let o = new k(-1, -1), s = i.v1, e = t[s], r = !1, h = null, a, c, g;
    const u = new Array(this.triangulation.length);
    for (; !h && !r; ) {
      if (u[e] = !0, this.triangleContainsConstraint(e, i))
        return null;
      if (h = this.edgeConstraintIntersectsTriangle(
        e,
        i
      ), h)
        break;
      if (a = this.triangulation[e][B], c = this.triangulation[e][E], g = this.triangulation[e][N], a !== Z && !u[a] && this.triangleContainsVertex(a, s))
        e = a;
      else if (c !== Z && !u[c] && this.triangleContainsVertex(c, s))
        e = c;
      else if (g !== Z && !u[g] && this.triangleContainsVertex(g, s))
        e = g;
      else {
        r = !0;
        break;
      }
    }
    if (h) {
      const f = this.triangulation[e][this.edgeVertex1[h]], x = this.triangulation[e][this.edgeVertex2[h]], p = this.triangulation[e][h];
      return o = new k(
        f,
        x,
        e,
        p,
        h
      ), o;
    }
    return null;
  }
  /// <summary>
  /// Remove the edges from the triangulation that intersect the constraint. Find two triangles that
  /// share the intersecting edge, swap the diagonal and repeat until no edges intersect the constraint.
  /// </summary>
  /// <param name="constraint">The constraint to check against</param>
  /// <param name="intersectingEdges">A queue containing the previously found edges that intersect the constraint</param>
  removeIntersectingEdges(t, i) {
    let o = [], s, e = 0;
    for (; i.length > 0 && e <= i.length; ) {
      s = i.shift();
      let r = this.findQuadFromSharedEdge(s.t1, s.t1Edge);
      if (r)
        if (D(
          this.points[r.q4].coords,
          this.points[r.q3].coords,
          this.points[r.q1].coords,
          this.points[r.q2].coords
        )) {
          this.swapQuadDiagonal(
            r,
            i,
            o,
            this.constraints
          );
          let h = new k(
            r.q3,
            r.q4,
            r.t1,
            r.t2,
            N
          );
          D(
            this.points[t.v1].coords,
            this.points[t.v2].coords,
            this.points[r.q3].coords,
            this.points[r.q4].coords
          ) ? i.push(h) : (e = 0, o.push(h));
        } else
          i.push(s);
      e++;
    }
    o.length > 0 && this.restoreConstrainedDelauneyTriangulation(t, o);
  }
  /// <summary>
  /// Restores the Delauney triangulation after the constraint has been inserted
  /// </summary>
  /// <param name="constraint">The constraint that was added to the triangulation</param>
  /// <param name="newEdges">The list of new edges that were added</param>
  restoreConstrainedDelauneyTriangulation(t, i) {
    let o = !0;
    for (; o; ) {
      o = !1;
      for (let s = 0; s < i.length; s++) {
        const e = i[s];
        if (e.equals(t))
          continue;
        let r = this.findQuadFromSharedEdge(e.t1, e.t1Edge);
        if (r && this.swapTest(
          this.points[r.q1].coords,
          this.points[r.q2].coords,
          this.points[r.q3].coords,
          this.points[r.q4].coords
        )) {
          this.swapQuadDiagonal(r, i, this.constraints, null);
          const h = r.q3, a = r.q4;
          i[s] = new k(h, a, r.t1, r.t2, N), o = !0;
        }
      }
    }
  }
  /**
   * Discards triangles that violate the any of the edge constraints
   */
  discardTrianglesViolatingConstraints() {
    this.skipTriangle.fill(!0);
    let t = /* @__PURE__ */ new Set();
    for (let x = 0; x < this.constraints.length; x++) {
      const p = this.constraints[x];
      t.add(F(p.v1, p.v2));
    }
    let i = [], o, s, e, r, h, a, c, g, u;
    const f = new Array(this.triangulation.length);
    for (let x = 0; x < this.triangleCount; x++)
      if (!f[x] && (o = this.triangulation[x][m], s = this.triangulation[x][v], e = this.triangulation[x][w], r = t.has(F(o, s)), h = t.has(F(s, e)), a = t.has(F(e, o)), c = t.has(F(s, o)), g = t.has(F(e, s)), u = t.has(F(o, e)), !(c || g || u) && (r || h || a)))
        for (this.skipTriangle[x] = !1, i = [], r || i.push(this.triangulation[x][B]), h || i.push(this.triangulation[x][E]), a || i.push(this.triangulation[x][N]); i.length > 0; ) {
          const p = i.shift();
          if (!(p === void 0 || p === Z || f[p])) {
            if (o = this.triangulation[p][m], s = this.triangulation[p][v], e = this.triangulation[p][w], c = t.has(F(s, o)), g = t.has(F(e, s)), u = t.has(F(o, e)), c || g || u) {
              f[p] = !0;
              continue;
            }
            this.skipTriangle[p] = !1, f[p] = !0, t.has(F(o, s)) || i.push(this.triangulation[p][B]), t.has(F(s, e)) || i.push(this.triangulation[p][E]), t.has(F(e, o)) || i.push(this.triangulation[p][N]);
          }
        }
  }
  /// <summary>
  /// Determines if the triangle contains the edge constraint
  /// </summary>
  /// <param name="t">The triangle to test</param>
  /// <param name="constraint">The edge constraint</param>
  /// <returns>True if the triangle contains one or both of the endpoints of the constraint</returns>
  triangleContainsConstraint(t, i) {
    return t >= this.triangulation.length ? !1 : (this.triangulation[t][m] === i.v1 || this.triangulation[t][v] === i.v1 || this.triangulation[t][w] === i.v1) && (this.triangulation[t][m] === i.v2 || this.triangulation[t][v] === i.v2 || this.triangulation[t][w] === i.v2);
  }
  /**
   * Returns true if the edge constraint intersects an edge of triangle `t`
   * @param t The triangle to test
   * @param constraint The edge constraint
   * @param intersectingEdgeIndex The index of the intersecting edge (E12, E23, E31)
   * @returns Returns true if an intersection is found, otherwise false.
   */
  edgeConstraintIntersectsTriangle(t, i) {
    const o = this.points[i.v1].coords, s = this.points[i.v2].coords, e = this.points[this.triangulation[t][m]].coords, r = this.points[this.triangulation[t][v]].coords, h = this.points[this.triangulation[t][w]].coords;
    return D(o, s, e, r) ? B : D(o, s, r, h) ? E : D(o, s, h, e) ? N : null;
  }
  /**
   *
   * @param t1 Base triangle
   * @param t1SharedEdge Edge index that is being intersected<
   * @returns Returns the quad formed by triangle `t1` and the other triangle that shares the intersecting edge
   */
  findQuadFromSharedEdge(t, i) {
    let o, s, e, r, h, a, c, g, u = this.triangulation[t][i], f = this.findSharedEdge(u, t);
    return f ? (f === B ? (s = this.triangulation[u][m], o = this.triangulation[u][v], e = this.triangulation[u][w]) : f === E ? (s = this.triangulation[u][v], o = this.triangulation[u][w], e = this.triangulation[u][m]) : (s = this.triangulation[u][w], o = this.triangulation[u][m], e = this.triangulation[u][v]), r = this.triangulation[t][this.oppositePoint[i]], h = this.triangulation[t][this.previousEdge[i]], a = this.triangulation[t][this.nextEdge[i]], c = this.triangulation[u][this.nextEdge[f]], g = this.triangulation[u][this.previousEdge[f]], new vt(o, s, e, r, t, u, h, a, c, g)) : null;
  }
  /**
   * Swaps the diagonal of the quadrilateral q0->q1->q2->q3 formed by t1 and t2
   */
  swapQuadDiagonal(t, i, o, s) {
    const e = t.t1, r = t.t2, h = t.t1R, a = t.t1L, c = t.t2R, g = t.t2L;
    this.triangulation[e][m] = t.q4, this.triangulation[e][v] = t.q1, this.triangulation[e][w] = t.q3, this.triangulation[r][m] = t.q4, this.triangulation[r][v] = t.q3, this.triangulation[r][w] = t.q2, this.triangulation[e][B] = a, this.triangulation[e][E] = g, this.triangulation[e][N] = r, this.triangulation[r][B] = e, this.triangulation[r][E] = c, this.triangulation[r][N] = h, this.updateAdjacency(g, r, e), this.updateAdjacency(h, e, r), this.updateEdgesAfterSwap(i, e, r, a, h, g, c), this.updateEdgesAfterSwap(o, e, r, a, h, g, c), this.updateEdgesAfterSwap(s, e, r, a, h, g, c), this.vertexTriangles[t.q1] = e, this.vertexTriangles[t.q2] = r;
  }
  /**
   * Update the edges
   */
  updateEdgesAfterSwap(t, i, o, s, e, r, h) {
    if (t)
      for (let a of t)
        a.t1 === i && a.t2 === e ? (a.t1 = o, a.t2 = e, a.t1Edge = N) : a.t1 === i && a.t2 === s ? a.t1Edge = B : a.t1 === e && a.t2 === i ? a.t2 = o : a.t1 === s && a.t2 === i || (a.t1 === o && a.t2 === h ? a.t1Edge = E : a.t1 === o && a.t2 === r ? (a.t1 = i, a.t2 = r, a.t1Edge = E) : a.t1 === h && a.t2 === o || a.t1 === r && a.t2 === o && (a.t2 = i));
  }
}
function tt(l, n, t, i, o, s = !1) {
  const e = new X(), r = new X(), h = new Array(l.vertexCount).fill(
    !1
  );
  for (let c = 0; c < l.vertices.length; c++) {
    const g = l.vertices[c];
    h[c] = ot(g.position, n, t), (h[c] ? e : r).addMappedVertex(g, c);
  }
  const a = l.vertices.length;
  for (let c = 0; c < l.cutVertices.length; c++) {
    const g = l.cutVertices[c];
    h[c + a] = ot(
      g.position,
      n,
      t
    ), (h[c + a] ? e : r).addMappedVertex(g, c + a);
  }
  return lt(
    l,
    e,
    r,
    n,
    t,
    h,
    K.Default
  ), lt(
    l,
    e,
    r,
    n,
    t,
    h,
    K.CutFace
  ), Mt(
    e,
    r,
    n.clone().negate(),
    i,
    o,
    s
  ), { topSlice: e, bottomSlice: r };
}
function Mt(l, n, t, i, o, s) {
  if (l.weldCutFaceVertices(), n.weldCutFaceVertices(), l.cutVertices.length < 3) return;
  const e = s ? new ht(l.cutVertices, t) : new wt(
    l.cutVertices,
    l.constraints,
    t
  ), r = e.triangulate();
  for (let u = 0; u < l.cutVertices.length; u++) {
    var h = l.cutVertices[u], a = e.points[u];
    const f = new z(
      e.normalizationScaleFactor * a.coords.x * i.x + o.x,
      e.normalizationScaleFactor * a.coords.y * i.y + o.y
    ), x = new U(
      h.position.clone(),
      t.clone(),
      f.clone()
    ), p = new U(
      h.position.clone(),
      t.clone().negate(),
      f.clone()
    );
    l.cutVertices[u] = x, n.cutVertices[u] = p;
  }
  let c = l.vertices.length, g = n.vertices.length;
  for (let u = 0; u < r.length; u += 3)
    l.addTriangle(
      c + r[u],
      c + r[u + 1],
      c + r[u + 2],
      K.CutFace
    ), n.addTriangle(
      g + r[u],
      g + r[u + 2],
      g + r[u + 1],
      K.CutFace
    );
}
function lt(l, n, t, i, o, s, e) {
  const r = l.triangles[e];
  let h, a, c;
  for (let g = 0; g < r.length; g += 3)
    h = r[g], a = r[g + 1], c = r[g + 2], s[h] && s[a] && s[c] ? n.addMappedTriangle(h, a, c, e) : !s[h] && !s[a] && !s[c] ? t.addMappedTriangle(h, a, c, e) : s[a] && s[c] && !s[h] ? L(
      a,
      c,
      h,
      i,
      o,
      l,
      n,
      t,
      e,
      !0
    ) : s[c] && s[h] && !s[a] ? L(
      c,
      h,
      a,
      i,
      o,
      l,
      n,
      t,
      e,
      !0
    ) : s[h] && s[a] && !s[c] ? L(
      h,
      a,
      c,
      i,
      o,
      l,
      n,
      t,
      e,
      !0
    ) : !s[a] && !s[c] && s[h] ? L(
      a,
      c,
      h,
      i,
      o,
      l,
      n,
      t,
      e,
      !1
    ) : !s[c] && !s[h] && s[a] ? L(
      c,
      h,
      a,
      i,
      o,
      l,
      n,
      t,
      e,
      !1
    ) : !s[h] && !s[a] && s[c] && L(
      h,
      a,
      c,
      i,
      o,
      l,
      n,
      t,
      e,
      !1
    );
}
function L(l, n, t, i, o, s, e, r, h, a) {
  let c = l < s.vertices.length ? s.vertices[l] : s.cutVertices[l - s.vertices.length], g = n < s.vertices.length ? s.vertices[n] : s.cutVertices[n - s.vertices.length], u = t < s.vertices.length ? s.vertices[t] : s.cutVertices[t - s.vertices.length];
  const f = rt(
    c.position,
    u.position,
    i,
    o
  ), x = rt(
    g.position,
    u.position,
    i,
    o
  );
  if (f && x) {
    const p = new y(
      c.normal.x + f.s * (u.normal.x - c.normal.x),
      c.normal.y + f.s * (u.normal.y - c.normal.y),
      c.normal.z + f.s * (u.normal.z - c.normal.z)
    ).normalize(), I = new y(
      g.normal.x + x.s * (u.normal.x - g.normal.x),
      g.normal.y + x.s * (u.normal.y - g.normal.y),
      g.normal.z + x.s * (u.normal.z - g.normal.z)
    ).normalize(), O = new z(
      c.uv.x + f.s * (u.uv.x - c.uv.x),
      c.uv.y + f.s * (u.uv.y - c.uv.y)
    ), _ = new z(
      g.uv.x + x.s * (u.uv.x - g.uv.x),
      g.uv.y + x.s * (u.uv.y - g.uv.y)
    );
    e.addCutFaceVertex(f.x, p, O), e.addCutFaceVertex(x.x, I, _), r.addCutFaceVertex(f.x, p, O), r.addCutFaceVertex(x.x, I, _);
    const j = e.vertices.length - 2, P = e.vertices.length - 1, J = r.vertices.length - 2, et = r.vertices.length - 1;
    a ? (e.addTriangle(
      P,
      j,
      e.indexMap[n],
      h
    ), e.addTriangle(
      j,
      e.indexMap[l],
      e.indexMap[n],
      h
    ), r.addTriangle(
      r.indexMap[t],
      J,
      et,
      h
    ), e.constraints.push(
      new k(
        e.cutVertices.length - 2,
        e.cutVertices.length - 1
      )
    ), r.constraints.push(
      new k(
        r.cutVertices.length - 1,
        r.cutVertices.length - 2
      )
    )) : (e.addTriangle(
      j,
      P,
      e.indexMap[t],
      h
    ), r.addTriangle(
      r.indexMap[l],
      r.indexMap[n],
      J,
      h
    ), r.addTriangle(
      r.indexMap[n],
      et,
      J,
      h
    ), e.constraints.push(
      new k(
        e.cutVertices.length - 1,
        e.cutVertices.length - 2
      )
    ), r.constraints.push(
      new k(
        r.cutVertices.length - 2,
        r.cutVertices.length - 1
      )
    ));
  }
}
function zt(l, n) {
  const t = new y(
    (l.x + n.x) / 2,
    (l.y + n.y) / 2,
    (l.z + n.z) / 2
  ), i = new y(
    n.x - l.x,
    n.y - l.y,
    n.z - l.z
  ).normalize();
  return { origin: t, normal: i };
}
function ct(l, n, t, i, o, s, e) {
  let r = l;
  const h = t[n], a = i || Vt(n, t.length);
  for (const c of a) {
    const g = t[c], u = zt(h, g), { bottomSlice: f } = tt(
      r,
      u.normal,
      u.origin,
      o,
      s,
      e
    );
    if (r = f, r.vertexCount === 0)
      return null;
  }
  return r;
}
function Vt(l, n) {
  const t = [];
  for (let i = 0; i < n; i++)
    i !== l && t.push(i);
  return t;
}
function ut(l, n, t) {
  const i = n[l], o = [];
  for (let s = 0; s < n.length; s++) {
    if (s === l) continue;
    const e = n[s].x - i.x, r = n[s].y - i.y, h = n[s].z - i.z, a = Math.sqrt(e * e + r * r + h * h);
    o.push({ index: s, distance: a });
  }
  return o.sort((s, e) => s.distance - e.distance), o.slice(0, Math.min(t, o.length)).map((s) => s.index);
}
function nt(l) {
  var e;
  const n = l.attributes.position.array, t = l.attributes.normal.array, i = (e = l.attributes.uv) == null ? void 0 : e.array, o = new X();
  for (let r = 0; r < n.length / 3; r++) {
    const h = new y(
      n[3 * r],
      n[3 * r + 1],
      n[3 * r + 2]
    ), a = new y(
      t[3 * r],
      t[3 * r + 1],
      t[3 * r + 2]
    ), c = i ? new z(i[2 * r], i[2 * r + 1]) : new z(0, 0);
    o.vertices.push(new U(h, a, c));
  }
  let s;
  if (l.index)
    s = Array.from(l.index.array);
  else {
    const r = n.length / 3;
    s = Array.from({ length: r }, (h, a) => a);
  }
  if (l.groups && l.groups.length === 2) {
    const r = [], h = [];
    for (const a of l.groups) {
      const c = a.materialIndex === 0 ? r : h, g = a.start, u = g + a.count;
      for (let f = g; f < u; f++)
        c.push(s[f]);
    }
    o.triangles = [r, h];
  } else
    o.triangles = [s, []];
  return o.calculateBounds(), o;
}
function it(l) {
  const n = new b.BufferGeometry(), t = l.vertices.length + l.cutVertices.length, i = new Array(t * 3), o = new Array(t * 3), s = new Array(t * 2);
  let e = 0, r = 0, h = 0;
  for (const a of l.vertices)
    i[e++] = a.position.x, i[e++] = a.position.y, i[e++] = a.position.z, o[r++] = a.normal.x, o[r++] = a.normal.y, o[r++] = a.normal.z, s[h++] = a.uv.x, s[h++] = a.uv.y;
  for (const a of l.cutVertices)
    i[e++] = a.position.x, i[e++] = a.position.y, i[e++] = a.position.z, o[r++] = a.normal.x, o[r++] = a.normal.y, o[r++] = a.normal.z, s[h++] = a.uv.x, s[h++] = a.uv.y;
  return n.addGroup(0, l.triangles[0].length, 0), n.addGroup(
    l.triangles[0].length,
    l.triangles[1].length,
    1
  ), n.setAttribute(
    "position",
    new b.BufferAttribute(new Float32Array(i), 3)
  ), n.setAttribute(
    "normal",
    new b.BufferAttribute(new Float32Array(o), 3)
  ), n.setAttribute(
    "uv",
    new b.BufferAttribute(new Float32Array(s), 2)
  ), n.setIndex(
    new b.BufferAttribute(new Uint32Array(l.triangles.flat()), 1)
  ), n;
}
class At {
  constructor(n) {
    d(this, "parent");
    d(this, "rank");
    this.parent = new Array(n), this.rank = new Array(n);
    for (let t = 0; t < n; t++)
      this.parent[t] = t, this.rank[t] = 1;
  }
  find(n) {
    return this.parent[n] !== n && (this.parent[n] = this.find(this.parent[n])), this.parent[n];
  }
  union(n, t) {
    const i = this.find(n), o = this.find(t);
    i !== o && (this.rank[i] > this.rank[o] ? this.parent[o] = i : this.rank[i] < this.rank[o] ? this.parent[i] = o : (this.parent[o] = i, this.rank[i] += 1));
  }
}
class gt {
  constructor(n) {
    d(this, "seed");
    d(this, "current");
    this.seed = n !== void 0 ? n : Math.floor(Math.random() * 2147483647), this.current = this.seed;
  }
  /**
   * Returns the seed value used by this random number generator
   */
  getSeed() {
    return this.seed;
  }
  /**
   * Returns a pseudo-random number between 0 (inclusive) and 1 (exclusive)
   */
  random() {
    return this.current = (this.current * 1664525 + 1013904223) % 4294967296, this.current / 4294967296;
  }
}
function Tt(l, n) {
  const t = new gt(n.seed), i = t.getSeed();
  n.seed === void 0 && (n.seed = i);
  const o = [l];
  for (; o.length < n.fragmentCount; ) {
    const s = o.shift();
    if (!s) continue;
    s.calculateBounds();
    const e = new y(
      n.fracturePlanes.x ? 2 * t.random() - 1 : 0,
      n.fracturePlanes.y ? 2 * t.random() - 1 : 0,
      n.fracturePlanes.z ? 2 * t.random() - 1 : 0
    ).normalize(), r = new y();
    s.bounds.getCenter(r);
    const { topSlice: h, bottomSlice: a } = tt(
      s,
      e,
      r,
      n.textureScale,
      n.textureOffset,
      !1
      // convex = false
    ), c = W(h), g = W(a);
    o.push(...c, ...g);
  }
  return o;
}
function W(l) {
  const n = new At(l.vertexCount), t = {}, i = l.vertices.length, o = l.cutVertices.length, s = /* @__PURE__ */ new Map();
  l.vertices.forEach((a, c) => {
    const g = Q(a.position), u = s.get(g);
    u === void 0 ? s.set(g, c) : n.union(u, c);
  });
  for (let a = 0; a < o; a++)
    n.union(l.vertexAdjacency[a], a + i);
  const e = l.triangles;
  for (let a = 0; a < e.length; a++)
    for (let c = 0; c < e[a].length; c += 3) {
      const g = e[a][c], u = e[a][c + 1], f = e[a][c + 2];
      n.union(g, u), n.union(u, f);
      const x = n.find(g);
      t[x] || (t[x] = [[], []]), t[x][a].push(g, u, f);
    }
  const r = {}, h = Array(l.vertexCount);
  for (let a = 0; a < i; a++) {
    const c = n.find(a);
    r[c] || (r[c] = new X()), r[c].vertices.push(l.vertices[a]), h[a] = r[c].vertices.length - 1;
  }
  for (let a = 0; a < o; a++) {
    const c = n.find(a + i);
    r[c].cutVertices.push(l.cutVertices[a]), h[a + i] = r[c].vertices.length + r[c].cutVertices.length - 1;
  }
  for (const a of Object.keys(t)) {
    let c = Number(a), g = n.parent[c];
    for (let u = 0; u < l.triangles.length; u++)
      for (const f of t[c][u]) {
        const x = h[f];
        r[g].triangles[u].push(x);
      }
  }
  return Object.values(r);
}
function Ct(l, n) {
  const t = new gt(n.seed), i = t.getSeed();
  n.seed === void 0 && (n.seed = i);
  const o = nt(l);
  let s;
  return n.mode === "3D" ? s = Et(o, n, t) : s = Nt(o, n, t), s.map((e) => it(e));
}
function Et(l, n, t) {
  const i = Ft(l, n, t), o = [], s = !1, e = n.useApproximation, r = Math.min(n.approximationNeighborCount, i.length - 1);
  e && console.warn(
    `⚠️ Voronoi approximation enabled (k=${r} neighbors). This may cause fragment overlaps.`,
    `
For accurate results with no overlaps, set useApproximation: false in VoronoiFractureOptions.`
  );
  for (let h = 0; h < i.length; h++) {
    const a = dt(l), c = e ? ut(h, i, r) : null, g = ct(
      a,
      h,
      i,
      c,
      n.textureScale,
      n.textureOffset,
      s
    );
    if (g && g.vertexCount > 0) {
      const u = W(g);
      o.push(...u);
    }
  }
  return o;
}
function Nt(l, n, t) {
  l.calculateBounds();
  let i;
  if (n.projectionNormal) {
    const a = n.projectionNormal, c = Math.abs(a.x), g = Math.abs(a.y), u = Math.abs(a.z);
    c > g && c > u ? i = "x" : g > c && g > u ? i = "y" : i = "z";
  } else {
    const a = n.projectionAxis || "auto";
    a === "auto" ? i = G.determineBestProjectionAxis(
      l.bounds
    ) : i = a;
  }
  let o;
  if (n.seedPoints)
    o = n.seedPoints;
  else if (n.impactPoint) {
    const a = n.impactRadius || Math.min(
      l.bounds.max.x - l.bounds.min.x,
      l.bounds.max.y - l.bounds.min.y,
      l.bounds.max.z - l.bounds.min.z
    ) * 0.3;
    o = G.generate2DImpactBased(
      l.bounds,
      n.fragmentCount,
      n.impactPoint,
      a,
      i,
      t
    );
  } else
    o = G.generate2D(
      l.bounds,
      n.fragmentCount,
      i,
      t
    );
  const s = [], e = !1, r = n.useApproximation, h = Math.min(n.approximationNeighborCount, o.length - 1);
  r && console.warn(
    `⚠️ Voronoi 2.5D approximation enabled (k=${h} neighbors). This may cause fragment overlaps.`,
    `
For accurate results with no overlaps, set useApproximation: false in VoronoiFractureOptions.`
  );
  for (let a = 0; a < o.length; a++) {
    const c = dt(l), g = r ? ut(a, o, h) : null, u = ct(
      c,
      a,
      o,
      g,
      n.textureScale,
      n.textureOffset,
      e
    );
    if (u && u.vertexCount > 0) {
      const f = W(u);
      s.push(...f);
    }
  }
  return s;
}
function Ft(l, n, t) {
  if (n.seedPoints && n.seedPoints.length > 0)
    return n.seedPoints;
  if (l.bounds || l.calculateBounds(), n.impactPoint) {
    const i = n.impactRadius || Math.min(
      l.bounds.max.x - l.bounds.min.x,
      l.bounds.max.y - l.bounds.min.y,
      l.bounds.max.z - l.bounds.min.z
    ) * 0.3;
    return G.generateImpactBased(
      l.bounds,
      n.fragmentCount,
      n.impactPoint,
      i,
      t
    );
  } else
    return G.generateUniform(
      l.bounds,
      n.fragmentCount,
      t
    );
}
function dt(l) {
  const n = new X();
  return n.vertices = l.vertices.map((t) => t.clone()), n.cutVertices = l.cutVertices.map((t) => t.clone()), n.triangles = l.triangles.map((t) => [...t]), n.constraints = l.constraints.map((t) => t.clone()), n.vertexAdjacency = [...l.vertexAdjacency], n.indexMap = { ...l.indexMap }, l.bounds && (n.bounds = l.bounds.clone()), n;
}
function It(l, n) {
  return Tt(nt(l), n).map((i) => it(i));
}
function qt(l, n, t, i, o) {
  const s = nt(l), { topSlice: e, bottomSlice: r } = tt(
    s,
    n,
    t,
    i,
    o
  ), h = W(e), a = W(r);
  return [...h, ...a].map((g) => it(g));
}
class ft extends b.Mesh {
  constructor(t, i, o) {
    super(t, i);
    d(this, "_outsideMaterial");
    d(this, "_insideMaterial");
    this._outsideMaterial = i, this._insideMaterial = o;
  }
  /**
   * Helper method to create a fragment with inherited properties and materials
   * @internal
   */
  createFragment(t) {
    const i = new ft(
      t,
      this._outsideMaterial,
      this._insideMaterial
    );
    return this._outsideMaterial && this._insideMaterial ? i.material = [this._outsideMaterial, this._insideMaterial] : this._outsideMaterial && (i.material = this._outsideMaterial), i.castShadow = this.castShadow, i.receiveShadow = this.receiveShadow, i.matrixAutoUpdate = this.matrixAutoUpdate, i.frustumCulled = this.frustumCulled, i.renderOrder = this.renderOrder, i;
  }
  /**
   * Fractures the mesh into fragments
   * @param options Fracture options controlling the fracture behavior
   * @param onFragment Optional callback called for each fragment for custom setup
   * @param onComplete Optional callback called once after all fragments are created
   * @returns The array of created fragment meshes (NOT added to scene)
   */
  fracture(t, i, o) {
    if (!this.geometry)
      throw new Error("DestructibleMesh has no geometry to fracture");
    let s;
    try {
      if (t.fractureMethod === "voronoi") {
        if (!t.voronoiOptions)
          throw new Error(
            "voronoiOptions is required when fractureMethod is 'voronoi'"
          );
        const r = {
          fragmentCount: t.fragmentCount,
          mode: t.voronoiOptions.mode,
          seedPoints: t.voronoiOptions.seedPoints,
          impactPoint: t.voronoiOptions.impactPoint,
          impactRadius: t.voronoiOptions.impactRadius,
          projectionAxis: t.voronoiOptions.projectionAxis || "auto",
          projectionNormal: t.voronoiOptions.projectionNormal,
          useApproximation: t.voronoiOptions.useApproximation || !1,
          approximationNeighborCount: t.voronoiOptions.approximationNeighborCount || 12,
          textureScale: t.textureScale,
          textureOffset: t.textureOffset,
          seed: t.seed
        };
        s = Ct(this.geometry, r);
      } else
        s = It(this.geometry, t);
    } catch (r) {
      throw console.error("Fracture operation failed:", r), r;
    }
    const e = s.map((r, h) => {
      r.computeBoundingBox();
      const a = new b.Vector3();
      r.boundingBox.getCenter(a), r.translate(-a.x, -a.y, -a.z), r.computeBoundingSphere();
      const c = this.createFragment(r), g = a.clone().applyMatrix4(this.matrixWorld);
      return c.position.copy(g), c.quaternion.copy(this.quaternion), c.scale.copy(this.scale), i && i(c, h), c;
    });
    return o && o(), e;
  }
  /**
   * Slices the mesh into top and bottom parts using a plane in local space
   * @param sliceNormal Normal of the slice plane in local space (points towards the top slice)
   * @param sliceOrigin Origin of the slice plane in local space
   * @param options Optional slice options
   * @param onSlice Optional callback called for each piece for custom setup (material, physics, etc.)
   * @param onComplete Optional callback called once after all pieces are created
   * @returns Array of DestructibleMesh pieces created by the slice (NOT added to scene)
   */
  slice(t, i, o, s, e) {
    if (!this.geometry)
      throw new Error("DestructibleMesh has no geometry to slice");
    const r = o || new yt(), a = qt(
      this.geometry,
      t,
      i,
      r.textureScale,
      r.textureOffset
    ).map((c, g) => {
      const u = this.createFragment(c);
      return u.position.copy(this.position), u.quaternion.copy(this.quaternion), u.scale.copy(this.scale), s && s(u, g), u;
    });
    return e && e(), a;
  }
  /**
   * Slices the mesh using a plane defined in world space
   * @param worldNormal Normal of the slice plane in world space
   * @param worldOrigin Origin of the slice plane in world space
   * @param options Optional slice options
   * @param onSlice Optional callback called for each piece for custom setup (material, physics, etc.)
   * @param onComplete Optional callback called once after all pieces are created
   * @returns Array of DestructibleMesh pieces created by the slice (NOT added to scene)
   */
  sliceWorld(t, i, o, s, e) {
    this.updateMatrixWorld(!0);
    const r = new b.Matrix4().copy(this.matrixWorld).invert(), h = t.clone().transformDirection(r).normalize(), a = i.clone().applyMatrix4(r);
    return this.slice(h, a, o, s, e);
  }
  /**
   * Disposes the mesh geometry and material
   */
  dispose() {
    this.geometry && this.geometry.dispose(), this.material && (Array.isArray(this.material) ? this.material.forEach((t) => t.dispose()) : this.material.dispose());
  }
}
class Ot {
  constructor({
    fractureMethod: n,
    fragmentCount: t,
    voronoiOptions: i,
    fracturePlanes: o,
    textureScale: s,
    textureOffset: e,
    seed: r
  } = {}) {
    /**
     * Fracture method to use
     * - 'voronoi': Natural-looking fracture using Voronoi tessellation (requires voronoiOptions)
     * - 'simple': Simple plane-based fracturing (fast, lower quality)
     */
    d(this, "fractureMethod", "voronoi");
    /**
     * Number of fragments to generate
     */
    d(this, "fragmentCount", 50);
    /**
     * Voronoi-specific options (required when fractureMethod is 'voronoi')
     */
    d(this, "voronoiOptions");
    /**
     * Simple fracture: specify which planes to fracture in
     * Only used when fractureMethod is 'simple'
     */
    d(this, "fracturePlanes", { x: !0, y: !0, z: !0 });
    /**
     * Scale factor to apply to texture coordinates on cut faces
     */
    d(this, "textureScale", new z(1, 1));
    /**
     * Offset to apply to texture coordinates on cut faces
     */
    d(this, "textureOffset", new z());
    /**
     * Seed value for random number generation. If not specified, a random seed will be generated.
     * Using the same seed will produce the same fracture pattern for reproducibility.
     */
    d(this, "seed");
    n !== void 0 && (this.fractureMethod = n), t !== void 0 && (this.fragmentCount = t), i !== void 0 && (this.voronoiOptions = i), o !== void 0 && (this.fracturePlanes = o), s !== void 0 && (this.textureScale = s), e !== void 0 && (this.textureOffset = e), r !== void 0 && (this.seed = r), this.fractureMethod === "voronoi" && !this.voronoiOptions && (this.voronoiOptions = {
      mode: "3D"
    });
  }
}
export {
  ft as DestructibleMesh,
  Ot as FractureOptions,
  yt as SliceOptions
};
