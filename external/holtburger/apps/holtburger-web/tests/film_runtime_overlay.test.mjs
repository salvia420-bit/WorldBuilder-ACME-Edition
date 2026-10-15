// tests/film_runtime_overlay.test.mjs
//
// WHY: the Egg Orchard FPV run (DESIGN §3) records its footage with the FPV props
// in front of the lens: two front propellers at the top corners, hard-mounted,
// spinning with the throttle. They are drawn by runtime/lens_overlay.js into the
// default framebuffer AFTER the composer, inside the take player's grab listener,
// right before recorder.grab. A bug here is in every recorded frame: props drawn
// AFTER the grab (the footage is clean, the screen is not), the renderer left with
// autoClear off or a render target bound (the next frame composites garbage), the
// overlay drawing on takes that never asked for it or without `?filmProps=on`, blade
// angles that depend on the wall clock (a stepped re-shoot differs), props over the
// middle of the frame, or anything that looks like a bad video link (noise, static,
// scanlines). This suite EXECUTES the real lens_overlay.js against the real three
// r184 (and a minimal fake THREE: the injected contract), a fake renderer, and the
// real take player / film/index.js with fakes:
//   O1 flags.js `?filmProps=on` — exact opt-in, memo + test pin;
//   O2 normalizeOverlay / propsPhase / propsLook (chop = crisper) / propsLayout
//      (top corners, partly out of frame, the frame centre and lower half never
//      covered, cinewhoop ducts at the top edge, wide fov never reaches the lens);
//   O3 procedural textures: deterministic, symmetric, smooth (no noise / scanlines);
//   O4 createLensOverlay: one render per draw, autoClear / render target /
//      info.autoReset set for the draw and restored, materials (unlit, no depth, no
//      fog, no tone mapping), deterministic angles, styles, off states, fake THREE;
//   O5 take player: drawn IMMEDIATELY before every recorder.grab (stepped and
//      realtime), never in rehearsals, without the flag or without overlay.props;
//      deterministic angles = 2π·(f0·t + f1·Θ(p)); throttle from traj.meta.throttleAt
//      or the nominal's thrust; the report's overlay {on, style, frames};
//   O6 film/index.js: an indoor take with an explicit path (no route) reaches the shot
//      builder's ctx.path, starts in take.cell, draws the props with filmProps and
//      flies pilot.fade 'never' (report.pilot.fade).
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) + filmProps (DEFAULT OFF, `?filmProps=on`).
// Run from apps/holtburger-web/: node tests/film_runtime_overlay.test.mjs

import assert from "node:assert/strict";

const THREE = await import("three");
const FLAGS = await import("../scene3d/film/flags.js");
const LO = await import("../scene3d/film/runtime/lens_overlay.js");
const TP = await import("../scene3d/film/runtime/take_player.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const { ensureFilmHooks } = await import("../scene3d/film/runtime/camera_owner.js");
const API = await import("../scene3d/film/index.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const tick = () => new Promise((r) => setImmediate(r));
const TAU = 2 * Math.PI;
const frac = (x) => x - Math.floor(x);

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** A WebGLRenderer stand-in: records every render() with the state it saw. */
function fakeRenderer(events = null, o = {}) {
  const r = {
    autoClear: true,
    info: { autoReset: true },
    domElement: { width: o.width ?? 1280, height: o.height ?? 720 },
    _target: o.target ?? null,
    renders: [],
    getRenderTarget() {
      return this._target;
    },
    setRenderTarget(t) {
      this._target = t;
    },
    render(scene, camera) {
      this.renders.push({ autoClear: this.autoClear, target: this._target, autoReset: this.info.autoReset, scene, camera, fov: camera.fov, aspect: camera.aspect });
      if (events) events.push("overlay");
    },
  };
  return r;
}

/** Every mesh of an overlay scene (world matrices updated). */
function meshesOf(scene) {
  scene.updateMatrixWorld(true);
  const out = [];
  scene.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

/**
 * NDC of every OPAQUE-ENOUGH texel centre of every mesh (alpha ≥ 8/255), seen by the overlay
 * camera: where the overlay really covers the frame (a quad's transparent corners do not count).
 */
function coveredNdc(scene, camera, step = 4) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const pts = [];
  for (const m of meshesOf(scene)) {
    const img = m.material.map.image;
    for (let j = 0; j < img.height; j += step) {
      for (let i = 0; i < img.width; i += step) {
        if (img.data[(j * img.width + i) * 4 + 3] < 8) continue;
        const v = new THREE.Vector3((i + 0.5) / img.width - 0.5, (j + 0.5) / img.height - 0.5, 0).applyMatrix4(m.matrixWorld);
        const z = v.applyMatrix4(camera.matrixWorldInverse).z;
        assert.ok(z < 0, "every drawn texel lies in front of the lens");
        v.applyMatrix4(camera.matrixWorld).project(camera);
        pts.push([v.x, v.y]);
      }
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// O1 flag
// ---------------------------------------------------------------------------

check("O1 filmPropsEnabled: exact '=== \"on\"' opt-in, independent of filmMode / filmDof, memoised + pinned, fails closed", () => {
  for (const s of ["", "?filmProps", "?filmProps=1", "?filmProps=true", "?filmProps=ON", "?filmProps=off", "?filmMode=on", "?filmDof=on"]) {
    assert.equal(FLAGS.filmPropsEnabled(s), false, s);
  }
  assert.equal(FLAGS.filmPropsEnabled("?filmMode=on&filmProps=on"), true);
  assert.equal(FLAGS.filmModeEnabled("?filmProps=on"), false, "filmProps does not imply filmMode");
  const prevWindow = globalThis.window;
  try {
    globalThis.window = { location: { search: "?filmProps=on" } };
    FLAGS._setFilmPropsEnabledForTest(null);
    assert.equal(FLAGS.filmPropsEnabled(), true);
    globalThis.window = { location: { search: "" } };
    assert.equal(FLAGS.filmPropsEnabled(), true, "memoised");
    FLAGS._setFilmPropsEnabledForTest(false);
    assert.equal(FLAGS.filmPropsEnabled(), false, "pinned");
    FLAGS._setFilmPropsEnabledForTest(null);
    globalThis.window = { get location() { throw new Error("boom"); } };
    assert.equal(FLAGS.filmPropsEnabled(), false, "a throwing location reads OFF");
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    FLAGS._setFilmPropsEnabledForTest(null);
  }
});

// ---------------------------------------------------------------------------
// O2 pure helpers
// ---------------------------------------------------------------------------

check("O2 normalizeOverlay: known styles only, opacity clamped, #rrggbb tint (else the style's), anything else → null", () => {
  assert.deepEqual(LO.normalizeOverlay({ props: { style: "freestyle" } }), { props: { style: "freestyle", opacity: 1, tint: LO.LENS_OVERLAY_LAYOUTS.freestyle.tint } });
  assert.deepEqual(LO.normalizeOverlay({ props: { style: "cinewhoop", opacity: 1.7, tint: "#A0B0C0" } }), { props: { style: "cinewhoop", opacity: 1, tint: "#a0b0c0" } });
  assert.equal(LO.normalizeOverlay({ props: { style: "freestyle", opacity: -2 } }).props.opacity, 0);
  assert.equal(LO.normalizeOverlay({ props: { style: "freestyle", tint: "red" } }).props.tint, LO.LENS_OVERLAY_LAYOUTS.freestyle.tint);
  for (const bad of [null, undefined, 3, "freestyle", [], {}, { props: null }, { props: [] }, { props: { style: "racing" } }, { props: {} }]) {
    assert.equal(LO.normalizeOverlay(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual([...LO.LENS_OVERLAY_STYLES], ["freestyle", "cinewhoop"]);
});

check("O2 propsPhase = f0·t + f1·Θ (a constant throttle k gives 2π·(f0 + f1·k)·t); propsLook: a chop is crisper than a punch", () => {
  const { f0, f1 } = LO.LENS_OVERLAY_SPIN;
  for (const [t, k] of [[0, 1], [1.5, 1], [12.25, 0.3], [97, 2.2]]) near(LO.propsPhase(t, k * t), (f0 + f1 * k) * t, 1e-12, `t=${t} k=${k}`);
  near(LO.propsPhase(2, 5), f0 * 2 + f1 * 5, 1e-12);
  assert.equal(LO.propsPhase(NaN, NaN), 0);
  const chop = LO.propsLook(0), hover = LO.propsLook(1), punch = LO.propsLook(2.5);
  assert.ok(chop.ghostOpacity > hover.ghostOpacity && hover.ghostOpacity > punch.ghostOpacity, "blades fade into the blur as the throttle rises");
  assert.ok(chop.discOpacity < hover.discOpacity && hover.discOpacity < punch.discOpacity, "the blur disc thickens with the throttle");
  assert.ok(chop.smearRad < punch.smearRad);
  assert.deepEqual(LO.propsLook(9), punch, "clamped");
  assert.equal(LO.propsLook(-1).mix, 0);
});

check("O2 propsLayout: freestyle hubs at the top corners, discs partly out of frame, the centre and the lower half never covered; cinewhoop ducts at the top edge; wide fovs never reach the lens", () => {
  for (const [fov, aspect] of [[70, 16 / 9], [100, 16 / 9], [100, 4 / 3], [120, 21 / 9]]) {
    const R = fakeRenderer(null, { width: Math.round(720 * aspect), height: 720 });
    for (const style of LO.LENS_OVERLAY_STYLES) {
      const L = LO.propsLayout(style, fov, aspect);
      assert.equal(L.props.length, 2);
      assert.deepEqual(L.props.map((p) => p.side), [-1, 1]);
      near(L.props[0].hub[0], -L.props[1].hub[0], 1e-12, "mirrored");
      const ov = LO.createLensOverlay({ THREE, renderer: R });
      ov.configure({ props: { style } });
      ov.draw({ t: 0.7, throttle: 1, fov });
      const last = R.renders[R.renders.length - 1];
      near(last.fov, fov, 1e-12);
      near(last.aspect, aspect, 1e-9, "the canvas aspect");
      const pts = coveredNdc(last.scene, last.camera);
      assert.ok(pts.length > 50, `${style} @${fov}°: something is drawn`);
      const inFrame = pts.filter(([x, y]) => Math.abs(x) <= 1 && Math.abs(y) <= 1);
      const outFrame = pts.length - inFrame.length;
      assert.ok(inFrame.length > 10 && outFrame > 10, `${style} @${fov}°: partly in frame (${inFrame.length}) and partly out of it (${outFrame})`);
      assert.ok(inFrame.every(([, y]) => y > 0), `${style} @${fov}°: only the upper half of the frame`);
      assert.ok(inFrame.every(([x, y]) => !(Math.abs(x) < 0.25 && y < 0.8)), `${style} @${fov}°: the frame centre is never covered`);
      assert.ok(inFrame.some(([x]) => x < -0.5) && inFrame.some(([x]) => x > 0.5), `${style} @${fov}°: one prop at each top corner`);
    }
  }
  const fs = LO.propsLayout("freestyle", 100, 16 / 9);
  assert.ok(Math.abs(fs.props[0].hubNdc[0]) < 1 && fs.props[0].hubNdc[1] >= 1 - 1e-12, "freestyle motor on the top edge, inside the side");
  const cw = LO.propsLayout("cinewhoop", 100, 16 / 9);
  assert.ok(cw.props[0].hubNdc[1] > 1, "cinewhoop motor above the frame: only its duct shows");
  assert.ok(cw.props[0].ductRadius > cw.props[0].radius);
  assert.equal(cw.blades, 5);
  assert.equal(fs.blades, 3);
  // A very wide fov clamps the disc so its near rim stays well in front of the lens.
  const wide = LO.propsLayout("freestyle", 150, 16 / 9);
  assert.ok(wide.props[0].radius * Math.cos(wide.uptiltRad) <= 0.78 + 1e-9);
  near(LO.propsLayout("freestyle", 100, 16 / 9, 40).uptiltRad, (40 * Math.PI) / 180, 1e-12, "uptilt from the shot");
});

// ---------------------------------------------------------------------------
// O3 textures
// ---------------------------------------------------------------------------

check("O3 procedural textures: deterministic, symmetric, smooth — no noise, static or scanlines", () => {
  const R = fakeRenderer();
  const ovA = LO.createLensOverlay({ THREE, renderer: R });
  const ovB = LO.createLensOverlay({ THREE, renderer: R });
  for (const style of LO.LENS_OVERLAY_STYLES) {
    ovA.configure({ props: { style } });
    ovB.configure({ props: { style } });
    const texA = [...new Set(meshesOf(ovA.scene()).map((m) => m.material.map))];
    const texB = [...new Set(meshesOf(ovB.scene()).map((m) => m.material.map))];
    assert.equal(texA.length, texB.length);
    texA.forEach((t, i) => assert.deepEqual(Array.from(t.image.data), Array.from(texB[i].image.data), "bit-identical when rebuilt"));
    for (const t of texA) {
      const { data, width: w, height: h } = t.image;
      assert.ok(data instanceof Uint8Array && data.length === w * h * 4);
      assert.equal(t.generateMipmaps, false);
      // Smooth: along every row and column the alpha turns around only a few times.
      const turns = (get, n) => {
        let c = 0;
        let sgn = 0;
        for (let i = 1; i < n; i += 1) {
          const dlt = get(i) - get(i - 1);
          if (Math.abs(dlt) < 3) continue;
          const s = Math.sign(dlt);
          if (sgn !== 0 && s !== sgn) c += 1;
          sgn = s;
        }
        return c;
      };
      let worst = 0;
      for (let j = 0; j < h; j += 1) worst = Math.max(worst, turns((i) => data[(j * w + i) * 4 + 3], w));
      for (let i = 0; i < w; i += 1) worst = Math.max(worst, turns((j) => data[(j * w + i) * 4 + 3], h));
      assert.ok(worst <= 6, `alpha profile turns ≤ 6 times per line (got ${worst}): smooth shapes, no grain`);
      // Neighbouring rows never alternate (no scanline pattern).
      for (let j = 2; j < h; j += 1) {
        let s0 = 0, s1 = 0, s2 = 0;
        for (let i = 0; i < w; i += 1) {
          s0 += data[((j - 2) * w + i) * 4 + 3];
          s1 += data[((j - 1) * w + i) * 4 + 3];
          s2 += data[(j * w + i) * 4 + 3];
        }
        assert.ok(!((s1 - s0) * (s2 - s1) < 0 && Math.abs(s1 - s0) > 4 * w && Math.abs(s2 - s1) > 4 * w), `row ${j}: no alternating scanlines`);
      }
    }
  }
  // The blur disc is radially symmetric with a transparent hub hole and a soft rim.
  const disc = LO.bakePixels((x, y) => {
    const rho = Math.hypot(x, y);
    return [1, rho < 1 ? 1 : 0];
  });
  assert.equal(disc.length, 128 * 128 * 4);
  ovA.configure({ props: { style: "freestyle" } });
  const dtex = meshesOf(ovA.scene()).find((m) => m.scale.x === 2 && m.material.map.image.width === 128).material.map.image;
  const a = (i, j) => dtex.data[(j * 128 + i) * 4 + 3];
  for (const [i, j] of [[10, 64], [30, 70], [100, 40], [64, 120]]) {
    assert.equal(a(i, j), a(j, i), "symmetric about the diagonal");
    assert.equal(a(i, j), a(127 - i, j), "mirror-symmetric");
  }
  assert.equal(a(64, 64), 0, "the hub hole is transparent");
  assert.equal(a(0, 0), 0, "the quad corners are transparent");
});

// ---------------------------------------------------------------------------
// O4 createLensOverlay
// ---------------------------------------------------------------------------

check("O4 draw(): one render into the default framebuffer with autoClear off, a bound render target and info.autoReset restored after; unlit, depthless, fogless, untone-mapped materials", () => {
  const target = { isWebGLRenderTarget: true, name: "composer-rt" };
  const R = fakeRenderer(null, { target });
  R.autoClear = true;
  const ov = LO.createLensOverlay({ THREE, renderer: R });
  assert.equal(ov.active, false);
  assert.deepEqual(ov.draw({ t: 1 }), { drawn: false, phaseRev: null, angles: null, look: null }, "nothing configured: no draw");
  assert.equal(R.renders.length, 0);
  const c = ov.configure({ props: { style: "freestyle", opacity: 0.8, tint: "#204060" } }, { uptiltDeg: 30 });
  assert.deepEqual(c, { ok: true, on: true, style: "freestyle" });
  assert.equal(ov.active, true);
  const out = ov.draw({ t: 2, throttle: 1, fov: 95 });
  assert.equal(out.drawn, true);
  assert.equal(R.renders.length, 1);
  const r = R.renders[0];
  assert.equal(r.autoClear, false, "drawn over the finished frame");
  assert.equal(r.target, null, "into the default framebuffer");
  assert.equal(r.autoReset, false, "the frame's renderer.info counts are not zeroed by the overlay");
  assert.equal(R.autoClear, true, "autoClear restored");
  assert.equal(R.getRenderTarget(), target, "render target restored");
  assert.equal(R.info.autoReset, true, "info.autoReset restored");
  assert.equal(r.camera.isPerspectiveCamera, true);
  near(r.camera.fov, 95, 1e-12);
  const ms = meshesOf(r.scene);
  assert.ok(ms.length > 0);
  for (const m of ms) {
    const mat = m.material;
    assert.equal(mat.isMeshBasicMaterial, true, "unlit");
    assert.equal(mat.transparent, true);
    assert.equal(mat.depthTest, false);
    assert.equal(mat.depthWrite, false);
    assert.equal(mat.fog, false);
    assert.equal(mat.toneMapped, false);
    assert.ok(mat.opacity <= 0.8 + 1e-12, "shot opacity applied");
  }
  const tinted = ms.filter((m) => m.material.color.getHexString() === new THREE.Color("#204060").getHexString());
  assert.ok(tinted.length >= 2 * (1 + 3 * 3), "disc + 3 blades × 3 ghosts per prop take the tint");
  // A render() that throws: state still restored, the error counted, never thrown.
  R.render = () => {
    throw new Error("context lost");
  };
  R.autoClear = true;
  assert.equal(ov.draw({ t: 3 }).drawn, false);
  assert.equal(R.autoClear, true);
  assert.equal(R.getRenderTarget(), target);
  assert.equal(ov.stats().errors, 1);
});

check("O4 blade angles are a pure function of (t, Θ): same film time → same angles and spinner pose; the props counter-rotate", () => {
  const R = fakeRenderer();
  const ov = LO.createLensOverlay({ THREE, renderer: R });
  ov.configure({ props: { style: "freestyle" } });
  const a = ov.draw({ t: 4.2, theta: 3.1, throttle: 0.8, fov: 100 });
  const spinA = R.renders[0].scene.children.map((g) => g.children[1].rotation.y);
  ov.draw({ t: 9, theta: 8, throttle: 2, fov: 80 });
  const b = ov.draw({ t: 4.2, theta: 3.1, throttle: 0.8, fov: 100 });
  assert.deepEqual(b.angles, a.angles);
  assert.deepEqual(R.renders[2].scene.children.map((g) => g.children[1].rotation.y), spinA);
  const ph = LO.propsPhase(4.2, 3.1);
  near(b.phaseRev, ph, 1e-12);
  near(a.angles[0], TAU * frac(ph), 1e-12, "left prop");
  near(a.angles[1], TAU * frac(-(ph + 0.21)), 1e-12, "right prop counter-rotates");
  // A second overlay instance agrees exactly (no hidden state).
  const R2 = fakeRenderer();
  const ov2 = LO.createLensOverlay({ THREE, renderer: R2 });
  ov2.configure({ props: { style: "freestyle" } });
  assert.deepEqual(ov2.draw({ t: 4.2, theta: 3.1, throttle: 0.8, fov: 100 }).angles, a.angles);
  // theta defaults to throttle·t (the literal 2π·(f0 + f1·throttle)·t).
  near(ov2.draw({ t: 3, throttle: 1.5, fov: 100 }).phaseRev, (LO.LENS_OVERLAY_SPIN.f0 + LO.LENS_OVERLAY_SPIN.f1 * 1.5) * 3, 1e-12);
});

check("O4 styles: freestyle = 3-blade props + motor + carbon arm stub; cinewhoop = 5-blade props inside two duct lips, no arm; style change rebuilds; off states", () => {
  const R = fakeRenderer();
  const ov = LO.createLensOverlay({ THREE, renderer: R });
  ov.configure({ props: { style: "freestyle" } });
  const fs = ov.scene();
  assert.equal(fs.children.length, 2, "two props");
  const g = fs.children[0];
  const spinner = g.children[1];
  assert.equal(spinner.children.length, 3 * LO.LENS_OVERLAY_LOOK.ghostsPerBlade);
  assert.ok(g.children.some((c) => c.isGroup && c !== spinner && c.children.length === 1 && c.children[0].material.color.getHexString() === "1d1e21"), "arm stub");
  ov.configure({ props: { style: "cinewhoop" } });
  const cw = ov.scene();
  assert.notEqual(cw, fs, "rebuilt for the new style");
  const g2 = cw.children[0];
  assert.equal(g2.children[1].children.length, 5 * LO.LENS_OVERLAY_LOOK.ghostsPerBlade);
  const lips = g2.children.filter((c) => c.isMesh && c.scale.x > 2.2);
  assert.equal(lips.length, 2, "upper + lower duct lip");
  assert.ok(!g2.children.some((c) => c.isGroup && c !== g2.children[1]), "no arm");
  assert.equal(ov.configure({ props: { style: "cinewhoop", opacity: 0.5 } }).on, true);
  assert.equal(ov.scene(), cw, "same style: no rebuild");
  // Off: no props, or nothing to draw with.
  assert.deepEqual(ov.configure(null), { ok: true, on: false, style: null, reason: "the shot has no overlay.props" });
  assert.equal(ov.active, false);
  const n = R.renders.length;
  assert.equal(ov.draw({ t: 1 }).drawn, false);
  assert.equal(R.renders.length, n);
  const noThree = LO.createLensOverlay({ renderer: R });
  assert.equal(noThree.configure({ props: { style: "freestyle" } }).on, false);
  const noRenderer = LO.createLensOverlay({ THREE, renderer: {} });
  assert.match(noRenderer.configure({ props: { style: "freestyle" } }).reason, /renderer/);
  ov.dispose();
  assert.equal(ov.active, false);
});

check("O4 the injected THREE contract: a minimal fake THREE (Scene, PerspectiveCamera, Group, Mesh, PlaneGeometry, MeshBasicMaterial, DataTexture) is enough", () => {
  const made = { textures: 0, materials: 0, meshes: 0 };
  class V3 {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.z = 0;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Obj {
    constructor() {
      this.position = new V3();
      this.rotation = new V3();
      this.scale = new V3().set(1, 1, 1);
      this.children = [];
    }
    add(c) {
      this.children.push(c);
      return this;
    }
  }
  const FAKE = {
    Scene: class extends Obj {},
    Group: class extends Obj {},
    PerspectiveCamera: class extends Obj {
      constructor(fov, aspect) {
        super();
        this.fov = fov;
        this.aspect = aspect;
        this.updates = 0;
      }
      updateProjectionMatrix() {
        this.updates += 1;
      }
    },
    Mesh: class extends Obj {
      constructor(g, m) {
        super();
        this.geometry = g;
        this.material = m;
        made.meshes += 1;
      }
    },
    PlaneGeometry: class {
      dispose() {}
    },
    MeshBasicMaterial: class {
      constructor(p) {
        Object.assign(this, p);
        this.color = { hex: p.color, set(h) { this.hex = h; } };
        made.materials += 1;
      }
      dispose() {}
    },
    DataTexture: class {
      constructor(data, w, h) {
        this.image = { data, width: w, height: h };
        made.textures += 1;
      }
      dispose() {}
    },
    RGBAFormat: 1023,
  };
  const R = fakeRenderer();
  const ov = LO.createLensOverlay({ THREE: FAKE, renderer: R });
  assert.equal(ov.configure({ props: { style: "freestyle" } }).on, true);
  const out = ov.draw({ t: 1.25, throttle: 1.1, fov: 90 });
  assert.equal(out.drawn, true);
  assert.equal(R.renders.length, 1);
  assert.ok(made.meshes > 0 && made.materials > 0 && made.textures >= 4);
  assert.equal(R.renders[0].camera.updates, 1, "projection updated once for the new fov");
  ov.draw({ t: 1.3, throttle: 1.1, fov: 90 });
  assert.equal(R.renders[1].camera.updates, 1, "unchanged fov / aspect: no re-layout");
});

// ---------------------------------------------------------------------------
// O5 take player
// ---------------------------------------------------------------------------

/** A straight north-bound dolly (classic) at 5 m/s, `meta` optional. */
function northDolly(D = 2, meta = undefined) {
  return TR.makeTrajectory({ id: "north", technique: "classic.dolly-in", family: "classic", duration: D, positionAt: (t) => [100, 100 + 5 * t, 10], orientAt: { h: 0, p: 0, r: 0 }, fov: 90, ...(meta ? { meta } : {}) });
}

/** Take player on fakes; `events` records 'overlay' (renderer.render) and 'grab' (recorder.grab) in order. */
function rig(o = {}) {
  const events = [];
  const live = { frameTime: { tsMs: 1000 } };
  const hooks = ensureFilmHooks(live);
  const writes = [];
  const cam = {
    owned: true,
    write(p) {
      writes.push({ t: p.t, pos: p.pos.slice(), fov: p.fov });
      return true;
    },
    currentPose: () => (writes.length ? { ...writes[writes.length - 1] } : null),
    setCutCell: (c) => c,
    viewerCell: () => 0,
    onPostRender: (fn) => hooks.addPostRender(fn),
  };
  let active = false;
  let lastTs = null;
  let fps = 30;
  const clock = {
    begin(b) {
      active = true;
      fps = b.fps;
      return { ok: true };
    },
    step() {
      lastTs = live.frameTime.tsMs + 1000 / fps;
      live.frameTime = { tsMs: lastTs };
      hooks.postRender();
      return Promise.resolve({});
    },
    async end() {
      active = false;
    },
    get active() {
      return active;
    },
    stats: () => ({ lastTsMs: lastTs }),
  };
  const grabs = [];
  const recorder = () => ({
    state: "idle",
    async start() {
      this.state = "recording";
    },
    grab(t) {
      events.push("grab");
      grabs.push(t);
      return true;
    },
    async stop() {
      this.state = "stopped";
      return { state: "stopped" };
    },
    abort() {
      this.state = "aborted";
      return { state: "aborted" };
    },
    stats() {
      return { state: this.state, errors: [] };
    },
    hasCapacity: () => true,
    async waitForCapacity() {},
  });
  const renderer = fakeRenderer(events);
  let made = 0;
  const overlay = LO.createLensOverlay({ THREE, renderer });
  const draws = [];
  const spy = {
    configure: (...a) => overlay.configure(...a),
    draw(f) {
      const r = overlay.draw(f);
      draws.push({ ...f, angles: r.angles, look: r.look });
      return r;
    },
  };
  const player = TP.createTakePlayer({
    cameraOwner: cam,
    clock,
    safety: { clamp: (prev, desired) => ({ pose: desired, adjusted: false, hits: [] }), reset() {}, release: () => 0 },
    recorder,
    worldQuery: { groundZ: () => 0 },
    liveScene3d: live,
    window: {},
    requestAnimationFrame: o.raf,
    lensOverlay: () => {
      made += 1;
      return spy;
    },
    propsEnabled: o.props ?? true,
  });
  return { live, hooks, events, grabs, renderer, overlay, draws, player, writes, made: () => made };
}

const FREESTYLE = { props: { style: "freestyle" } };

check("O5 stepped shoot: the props are drawn IMMEDIATELY before every recorder.grab, once per recorded frame, renderer state restored; report overlay {on, style, frames}", async () => {
  const R = rig();
  const fps = 10;
  const sum = R.player.prepare({ trajectory: northDolly(2), capture: { fps }, overlay: FREESTYLE });
  assert.deepEqual(sum.overlay, { style: "freestyle", opacity: 1, tint: LO.LENS_OVERLAY_LAYOUTS.freestyle.tint });
  const rep = await R.player.shoot({ fps });
  assert.equal(rep.frames, 20);
  assert.equal(R.grabs.length, 20);
  assert.equal(R.events.length, 40);
  for (let i = 0; i < R.events.length; i += 2) assert.deepEqual(R.events.slice(i, i + 2), ["overlay", "grab"], `frame ${i / 2}: overlay then grab`);
  assert.deepEqual(rep.overlay, { on: true, style: "freestyle", frames: 20, throttleSource: "nominal" });
  assert.equal(R.renderer.autoClear, true);
  assert.equal(R.renderer.getRenderTarget(), null);
  assert.equal(R.renderer.info.autoReset, true);
  // Each draw used its frame's film time, the pose's fov and a hover throttle (a constant-speed dolly).
  R.draws.forEach((dr, k) => {
    near(dr.t, k / fps, 1e-12, "film time of the frame");
    near(dr.fov, 90, 1e-9);
    near(dr.throttle, 1, 1e-6, "constant speed = hover");
    near(dr.theta, k / fps, 1e-6, "Θ = ∫ 1 dt");
  });
  assert.equal(R.made(), 1);
});

check("O5 deterministic: two stepped shoots draw identical blade angles; angle(k) = 2π·frac(f0·t + f1·Θ(p)); a slowed take spins on film time", async () => {
  const run = async () => {
    const R = rig();
    R.player.prepare({ trajectory: northDolly(1.5), capture: { fps: 12 }, overlay: FREESTYLE });
    await R.player.shoot({ fps: 12 });
    return R.draws.map((d) => d.angles);
  };
  const a = await run();
  const b = await run();
  assert.equal(a.length, 18);
  assert.deepEqual(a, b);
  const { f0, f1 } = LO.LENS_OVERLAY_SPIN;
  a.forEach((ang, k) => near(ang[0], TAU * frac(f0 * (k / 12) + f1 * (k / 12)), 1e-9, `frame ${k}`));
});

check("O5 throttle from traj.meta.throttleAt (source 'meta'): a free fall shows crisp blades, a punch a dense disc; Θ integrates it", async () => {
  const thr = (p) => (p < 1 ? 0 : 2.5);
  const R = rig();
  R.player.prepare({ trajectory: northDolly(2, { throttleAt: thr }), capture: { fps: 10 }, overlay: FREESTYLE });
  const rep = await R.player.shoot({ fps: 10 });
  assert.equal(rep.overlay.throttleSource, "meta");
  const fall = R.draws[5], punch = R.draws[15];
  near(fall.throttle, 0, 1e-12);
  near(punch.throttle, 2.5, 1e-12);
  assert.ok(fall.look.ghostOpacity > punch.look.ghostOpacity && fall.look.discOpacity < punch.look.discOpacity);
  near(fall.theta, 0, 1e-9, "no throttle → no throttle spin");
  near(punch.theta, 2.5 * 0.5 + 0.5 * 2.5 * (1 / 60), 1e-9, "∫ over the second half (+ the table's one-step ramp at p = 1)");
  // The nominal thrust: a vertical punch (a = +g) reads 2 × hover.
  const up = TR.makeTrajectory({ id: "up", technique: "classic.crane-up", family: "classic", duration: 2, positionAt: (t) => [0, 0, 10 + 0.5 * 9.80665 * t * t], orientAt: { h: 0, p: 0, r: 0 } });
  const tb = TP.overlayThrottleTable(up, 2);
  assert.equal(tb.source, "nominal");
  near(TP.tableThrottle(tb, 1), 2, 1e-6);
  near(TP.tableTheta(tb, 1), 2, 1e-6);
  // A locked replay's trajectory is a lerped table: its thrust stays smooth (no frame-to-frame flicker).
  const curve = TR.makeTrajectory({ id: "c", technique: "classic.dolly-in", family: "classic", duration: 4, positionAt: (t) => [20 * Math.sin(t / 2), 8 * t, 3 + Math.sin(t)], orientAt: { h: 0, p: 0, r: 0 } });
  const replay = TR.trajectoryFromTable(TR.bakeTrajectory(curve, 30));
  const tr = TP.overlayThrottleTable(replay, 3.9);
  const tn = TP.overlayThrottleTable(curve, 3.9);
  let jump = 0, off = 0;
  for (let i = 1; i < tr.n; i += 1) jump = Math.max(jump, Math.abs(tr.thr[i] - tr.thr[i - 1]));
  for (let i = 12; i < tr.n - 12; i += 1) off = Math.max(off, Math.abs(tr.thr[i] - tn.thr[i]));
  assert.ok(jump < 0.02, `replayed table: smooth throttle (largest 1/60 s step ${jump})`);
  assert.ok(off < 0.05, `replayed table ≈ the nominal's thrust (${off})`);
});

check("O5 no-op: without ?filmProps=on, without overlay.props, and in rehearsals nothing is drawn (the report says why)", async () => {
  const off = rig({ props: false });
  off.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 }, overlay: FREESTYLE });
  const r1 = await off.player.shoot({ fps: 10 });
  assert.equal(off.renderer.renders.length, 0);
  assert.deepEqual(off.events, Array(10).fill("grab"));
  assert.deepEqual(r1.overlay, { on: false, style: "freestyle", frames: 0, reason: "?filmProps=on is not set" });
  assert.equal(off.made(), 0, "the overlay is never even made");
  const none = rig();
  const s = none.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  assert.equal("overlay" in s, false, "no overlay in the summary of a take that asks for none");
  const r2 = await none.player.shoot({ fps: 10 });
  assert.equal(none.renderer.renders.length, 0);
  assert.deepEqual(r2.overlay, { on: false, style: null });
  assert.equal(none.made(), 0);
  const reh = rig();
  reh.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 }, overlay: FREESTYLE });
  const r3 = await reh.player.rehearse({ fps: 10 });
  assert.equal(reh.renderer.renders.length, 0);
  assert.equal(r3.overlay.on, false);
  assert.match(r3.overlay.reason, /not recorded/);
  // A propsEnabled function is read per take; a throwing one reads off.
  const fn = rig({ props: () => {
    throw new Error("x");
  } });
  fn.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 }, overlay: FREESTYLE });
  assert.equal((await fn.player.shoot({ fps: 10 })).overlay.on, false);
});

check("O5 realtime takes: the props go on each drawn frame before its film-grid grab (held frames once)", async () => {
  const queue = [];
  const raf = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  const R = rig({ raf });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10, mode: "realtime" }, overlay: { props: { style: "cinewhoop" } } });
  const p = R.player.shoot({ fps: 10 });
  await tick();
  let ts = 5000;
  for (let n = 0; queue.length && n < 200; n += 1) {
    const cb = queue.shift();
    ts += 200; // a 5 Hz display: every drawn frame covers 2 grid points
    cb(ts);
    R.hooks.postRender();
    await tick();
  }
  const rep = await p;
  assert.equal(rep.mode, "realtime");
  assert.equal(rep.overlay.on, true);
  assert.equal(rep.overlay.style, "cinewhoop");
  assert.ok(R.events.length > 0);
  for (let i = 0; i < R.events.length; i += 2) assert.deepEqual(R.events.slice(i, i + 2), ["overlay", "grab"]);
  assert.equal(rep.overlay.frames, R.grabs.length, "one draw per drawn (grabbed) frame");
  assert.ok(R.grabs.some((g) => Array.isArray(g) && g.length > 1), "held frames are grabbed once for several grid points");
});

// ---------------------------------------------------------------------------
// O6 film/index.js
// ---------------------------------------------------------------------------

const LB = 0xa9b40000;
const LBX = 0xa9 * 192;
const LBY = 0xb4 * 192;

class FakeSwitcher {
  constructor() {
    this.persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
    this.mode = "follow";
    this.activeCamera = this.persp;
    this.followYaw = 0.5;
    this.followPitch = 0.2;
    this.keys = { w: false };
  }
  positionCamera() {
    this.persp.position.set(1, 2, 3);
  }
  switchMode(m) {
    this.mode = m;
  }
  _applyCameraPlayerFade(o) {
    this._camFadeLastOpacity = o;
  }
  getPlayerWorldPosition(out) {
    out.set(5, 6, 7);
    return out;
  }
}

function fakeScene() {
  const cs = new FakeSwitcher();
  const canvas = { width: 640, height: 360, toDataURL: () => "data:image/jpeg;base64,AA==" };
  const live = {
    frameTime: { tsMs: 1000 },
    renderer: { domElement: canvas, toneMappingExposure: 1 },
    entityManager: { entityMap: new Map(), _filmHiddenGuids: new Set(), setFilmHidden: () => true, setSelectedTarget() {}, getSelectedTarget: () => 0 },
    terrainBakedLbs: new Set([LB]),
    staticsGroup: { children: [] },
    cellContainers3d: new Map(),
    cameraSwitcher: cs,
    camera: cs.persp,
  };
  const win = {
    liveScene3d: live,
    performance: { now: () => 1e12 },
    __renderOnce(ts) {
      const t = Number.isFinite(ts) ? ts : live.frameTime.tsMs + 16;
      const prev = live.frameTime.tsMs;
      live.frameTime = { tsMs: t };
      if (live.film && typeof live.film.preFrame === "function") live.film.preFrame(t, (t - prev) / 1000);
      cs.positionCamera();
      if (live.film && typeof live.film.postRender === "function") live.film.postRender();
      return true;
    },
    addEventListener() {},
    removeEventListener() {},
    __isPortalSpaceActive: () => false,
    getLocalPlayerGuid: () => 0x50000001,
  };
  const sh = {
    terrainHeightAt: () => 0,
    getLocalPlayerPose: () => ({ landblockId: 0xa9b4001c, x: 50, y: 50, z: 0, heading: 0, isOnGround: true, free() {} }),
    playerGuid: () => 0x50000001,
    sendChat() {},
    isPlayerReady: () => true,
  };
  return { live, win, sh, cs };
}

function makeEncoder() {
  return class {
    static async isConfigSupported(cfg) {
      return { supported: cfg.codec === "avc1.640033", config: cfg };
    }
    constructor({ output }) {
      this.output = output;
      this.encodeQueueSize = 0;
      this.seq = 0;
    }
    configure() {}
    encode(frame, opts) {
      const bytes = new Uint8Array([0, 0, 0, 1, opts && opts.keyFrame ? 0x65 : 0x41, this.seq++ & 0xff]);
      this.output({ type: opts && opts.keyFrame ? "key" : "delta", timestamp: frame.timestamp, duration: frame.duration, byteLength: bytes.length, copyTo: (d) => d.set(bytes) });
    }
    async flush() {}
    close() {}
  };
}
class FakeFrame {
  constructor(src, init) {
    this.timestamp = init.timestamp;
    this.duration = init.duration;
  }
  close() {}
}

const CELL = 0xa9b40105;
const PATH = [[LBX + 40, LBY + 40, -10], [LBX + 40, LBY + 60, -10], [LBX + 55, LBY + 70, -12]];

/** A compiled indoor Take with an explicit racing line and no route (plan shot.path, site.indoor). */
function indoorPathTake(extra = {}) {
  return {
    shotId: "run",
    siteId: "orchard",
    technique: "fpv.fpv-corridor",
    family: "fpv",
    spec: { technique: "fpv.fpv-corridor", duration: 3, params: {}, seed: 3 },
    subject: null,
    path: PATH,
    route: null,
    standingOrder: "Race the line.",
    goal: null,
    pilot: { mode: "code", fade: "never" },
    capture: { mode: "stepped", fps: 10, width: 640, height: 360 },
    look: {},
    actor: null,
    cell: `0x${CELL.toString(16)}`,
    indoor: true,
    anchor: PATH[0],
    preRollSec: 0,
    overlay: FREESTYLE,
    ...extra,
  };
}

async function installed(extra = {}) {
  const S = fakeScene();
  const api = API.installFilmMode({
    liveScene3d: S.live, THREE, sessionHandle: S.sh, wasmExports: {}, window: S.win,
    document: { getElementById: () => null, createElement: () => ({ getContext: () => null }), head: { appendChild() {} }, documentElement: { classList: { add() {}, remove() {}, contains: () => false } } },
    VideoEncoder: makeEncoder(), VideoFrame: FakeFrame, log: () => {},
    modules: { timeRng: null, fxTime: null, sceneryTime: null, vfxCatalog: null },
    ...extra,
  });
  await api.__runtime.ready();
  for (let i = 0; i < 50 && !api.status().runtimeReady; i += 1) await tick();
  return { S, api };
}

check("O6 film/index.js: an indoor take with an explicit path and no route flies ctx.path from take.cell; filmProps draws the props; pilot.fade 'never' reaches the mapper", async () => {
  const events = [];
  const renderer = fakeRenderer(events);
  const overlay = LO.createLensOverlay({ THREE, renderer });
  const { S, api } = await installed({ filmProps: true, lensOverlay: overlay });
  assert.equal(api.status().flags.filmProps, true);
  const prep = await api.prepare(indoorPathTake());
  assert.equal(prep.ok, true, JSON.stringify(prep.error));
  assert.equal(prep.route, null, "no indoor route was planned");
  assert.deepEqual(prep.sun, { available: false, reason: "indoors", headingDeg: null, pitchDeg: null });
  assert.equal(prep.overlay.style, "freestyle");
  const reh = await api.rehearse({ fps: 10 });
  assert.equal(reh.ok, true, JSON.stringify(reh.error));
  const rows = reh.realisedTable.rows;
  const first = rows.slice(1, 4);
  const last = rows.slice((reh.frames - 1) * TR.TABLE_STRIDE + 1, (reh.frames - 1) * TR.TABLE_STRIDE + 4);
  assert.ok(Math.hypot(first[0] - PATH[0][0], first[1] - PATH[0][1]) < 1.5, `starts on the path (${first})`);
  assert.ok(Math.hypot(last[0] - PATH[2][0], last[1] - PATH[2][1]) < 6, `ends near the path's end (${last}; filleted, flown, last row at 2.9 s)`);
  assert.ok(last[1] - first[1] > 20, "flew along the racing line");
  assert.equal(api.status().viewerCell, `0x${CELL.toString(16).toUpperCase().padStart(8, "0")}`, "the carried film viewer cell starts at take.cell");
  assert.equal(reh.pilot.fade, "never", "pilot.fade 'never' → mapper maxFadeIds 0");
  assert.equal(renderer.renders.length, 0, "a rehearsal is not recorded: no props");
  const shot = await api.shoot({ fps: 10 });
  assert.equal(shot.ok, true, JSON.stringify(shot.error));
  assert.equal(shot.overlay.on, true);
  assert.equal(shot.overlay.frames, shot.frames);
  assert.equal(renderer.renders.length, shot.frames);
  assert.equal(S.cs.getPlayerWorldPosition.name, "filmEyeWorldPosition", "lights rank at the film eye while owned");
  // Without fade 'never' the pilot fades as before; without filmProps the props stay off.
  const { api: api2 } = await installed({ filmProps: false, lensOverlay: LO.createLensOverlay({ THREE, renderer: fakeRenderer() }) });
  assert.equal(api2.status().flags.filmProps, false);
  assert.equal((await api2.prepare(indoorPathTake({ pilot: { mode: "code" } }))).ok, true);
  const shot2 = await api2.shoot({ fps: 10 });
  assert.equal(shot2.ok, true, JSON.stringify(shot2.error));
  assert.equal(shot2.pilot.fade, "auto");
  assert.deepEqual(shot2.overlay, { on: false, style: "freestyle", frames: 0, reason: "?filmProps=on is not set" });
  api.dispose();
  api2.dispose();
  assert.equal(Object.prototype.hasOwnProperty.call(S.cs, "getPlayerWorldPosition"), false, "released on dispose");
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`film_runtime_overlay: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
