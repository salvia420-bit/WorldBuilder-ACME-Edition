
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
const AdditiveBlending = 2;
const FrontSide = 0;
const DoubleSide = 2;
export {
  Vector3, Quaternion, Object3D, Mesh,
  SphereGeometry, TorusGeometry, BoxGeometry, MeshBasicMaterial,
  AdditiveBlending, FrontSide, DoubleSide,
};
