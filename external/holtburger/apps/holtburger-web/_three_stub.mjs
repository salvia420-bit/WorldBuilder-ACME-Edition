
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
}
class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
}
class Object3D {
  constructor() {
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.rotation = { x: 0, y: 0, z: 0 };
    this.children = [];
    this.parent = null;
    this.name = "";
    this.renderOrder = 0;
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); child.parent = null; }
  }
}
class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
class SphereGeometry { constructor() {} dispose() {} }
class TorusGeometry { constructor() {} dispose() {} }
class BoxGeometry { constructor() {} dispose() {} }
class MeshBasicMaterial { constructor(opts = {}) { Object.assign(this, opts); } dispose() {} }
// (2026-08-02) Added for the carnage/dismember suites: those modules construct
// a material and a couple of scratch vectors at MODULE scope, so a bare import
// needs these to exist. Everything below is additive — no existing stub member
// changed shape.
class MeshStandardMaterial { constructor(opts = {}) { Object.assign(this, opts); } dispose() {} }
class Box3 {
  constructor() { this.min = new Vector3(); this.max = new Vector3(); }
  setFromObject() { return this; }
  getCenter(t) { return (t || new Vector3()).set(0, 0, 0); }
  getSize(t) { return (t || new Vector3()).set(1, 1, 1); }
}
class Matrix3 { getNormalMatrix() { return this; } }
class Matrix4 {
  copy() { return this; }
  invert() { return this; }
  multiplyMatrices() { return this; }
  makeTranslation() { return this; }
  clone() { return new Matrix4(); }
  decompose() { return this; }
}
class BufferGeometry {
  constructor() { this.userData = {}; this.boundingBox = null; this.boundingSphere = null; }
  setAttribute() { return this; }
  getAttribute() { return null; }
  setIndex() { return this; }
  getIndex() { return null; }
  computeBoundingBox() { this.boundingBox = new Box3(); }
  computeBoundingSphere() { this.boundingSphere = { radius: 0 }; }
  dispose() {}
}
class Float32BufferAttribute { constructor(a, s) { this.array = a; this.itemSize = s; } }
const AdditiveBlending = 2;
const FrontSide = 0;
const DoubleSide = 2;
export {
  Vector3, Quaternion, Object3D, Mesh,
  SphereGeometry, TorusGeometry, BoxGeometry, MeshBasicMaterial,
  MeshStandardMaterial, Box3, Matrix3, Matrix4, BufferGeometry, Float32BufferAttribute,
  AdditiveBlending, FrontSide, DoubleSide,
};
