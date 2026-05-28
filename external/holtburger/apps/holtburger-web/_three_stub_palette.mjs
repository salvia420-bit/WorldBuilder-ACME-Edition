
class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x,y){this.x=x;this.y=y;return this;} clone(){return new Vector2(this.x,this.y);} }
class Vector3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;} set(x,y,z){this.x=x;this.y=y;this.z=z;return this;} setScalar(s){this.x=this.y=this.z=s;return this;} clone(){return new Vector3(this.x,this.y,this.z);} normalize(){const l=Math.hypot(this.x,this.y,this.z)||1;this.x/=l;this.y/=l;this.z/=l;return this;} }
class Vector4 { constructor(x=0,y=0,z=0,w=0){this.x=x;this.y=y;this.z=z;this.w=w;} }
class Matrix4 { constructor(){} clone(){return new Matrix4();} }
class Quaternion { constructor(x=0,y=0,z=0,w=1){this.x=x;this.y=y;this.z=z;this.w=w;} }
class Color { constructor(){} }
class BufferAttribute { constructor(arr,size,norm){this.array=arr;this.itemSize=size;this.normalized=norm;} }
class BufferGeometry { constructor(){this.attributes={};this.index=null;} setAttribute(name,attr){this.attributes[name]=attr;return this;} setIndex(i){this.index=i;return this;} computeBoundingSphere(){} computeVertexNormals(){} dispose(){} }
class Object3D {
  constructor(){this.position=new Vector3();this.scale=new Vector3(1,1,1);this.rotation={x:0,y:0,z:0};this.children=[];this.parent=null;this.name="";this.userData={};this.renderOrder=0;}
  add(c){this.children.push(c);c.parent=this;}
  remove(c){const i=this.children.indexOf(c);if(i>=0){this.children.splice(i,1);c.parent=null;}}
}
class Mesh extends Object3D { constructor(geom,mat){super();this.geometry=geom;this.material=mat;this.receiveShadow=false;this.castShadow=false;} }
class SphereGeometry { constructor(){} dispose(){} }
class TorusGeometry { constructor(){} dispose(){} }
class BoxGeometry { constructor(){} dispose(){} }
class PlaneGeometry { constructor(){} dispose(){} }
class MeshBasicMaterial { constructor(opts={}){Object.assign(this,opts);this.userData={};} dispose(){} }
class MeshStandardMaterial { constructor(opts={}){Object.assign(this,opts);this.userData={};} dispose(){} }
class ShaderMaterial { constructor(opts={}){Object.assign(this,opts);this.userData={};} dispose(){} }
class Material { dispose(){} }
class Texture { constructor(){this.colorSpace=0;this.needsUpdate=false;} dispose(){} }
class DataTexture {
  constructor(data,w,h,format,type){
    this.image={data,width:w,height:h};
    this.format=format;
    this.type=type;
    this.colorSpace=0;
    this.magFilter=0;
    this.minFilter=0;
    this.generateMipmaps=true;
    this.wrapS=0;
    this.wrapT=0;
    this.needsUpdate=false;
  }
  dispose(){}
}
class DataArrayTexture {
  constructor(data,w,h,depth){
    this.image={data,width:w,height:h,depth};
    this.colorSpace=0;
    this.needsUpdate=false;
  }
  dispose(){}
}
class CanvasTexture {
  constructor(canvas){this.canvas=canvas;this.needsUpdate=false;}
  dispose(){}
}
class Raycaster {
  constructor(){this.ray={origin:new Vector3(),direction:new Vector3()};}
  set(origin,direction){this.ray.origin.copy(origin);this.ray.direction.copy(direction);}
  intersectObject(){return [];}
  intersectObjects(){return [];}
}
const RGBAFormat = 1023;
const UnsignedByteType = 1009;
const NearestFilter = 1003;
const LinearFilter = 1006;
const LinearMipmapLinearFilter = 1008;
const ClampToEdgeWrapping = 1001;
const RepeatWrapping = 1000;
const SRGBColorSpace = "srgb";
const LinearSRGBColorSpace = "srgb-linear";
const NoColorSpace = "";
const AdditiveBlending = 2;
const FrontSide = 0;
const DoubleSide = 2;
const GLSL3 = "300 es";
export {
  Vector2, Vector3, Vector4, Matrix4, Quaternion, Color,
  BufferAttribute, BufferGeometry,
  Object3D, Mesh,
  SphereGeometry, TorusGeometry, BoxGeometry, PlaneGeometry,
  MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial, Material,
  Texture, DataTexture, DataArrayTexture, CanvasTexture, Raycaster,
  RGBAFormat, UnsignedByteType,
  NearestFilter, LinearFilter, LinearMipmapLinearFilter,
  ClampToEdgeWrapping, RepeatWrapping,
  SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace,
  AdditiveBlending, FrontSide, DoubleSide,
  GLSL3,
};
