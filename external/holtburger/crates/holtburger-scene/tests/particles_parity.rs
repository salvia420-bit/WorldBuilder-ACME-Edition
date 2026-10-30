//! particles kernel vs the real JS particle runtime (fixtures written by
//! apps/holtburger-web/tools/rust_parity/gen_particles.mjs, which runs the JS
//! ParticleManager with a scripted clock and a recording RNG and records both
//! the inputs the ?rustParticles bridge would hand the kernel and what the JS
//! path wrote into the three.js buckets).
//!
//! Exact bit equality for everything, except buckets / kid layers fed by an
//! emitter of a trig-bearing type (Swarm, Explode, Implode, the three GR
//! spins): there positions and rotations may differ by 1 f32 ulp (V8's fdlibm
//! vs the host libm), and the `?fxMotion` / kid velocities — finite
//! differences of f32-stored positions — are compared to 1e-3 absolute.
//! Counts, capacities, creation order, opacity / age / FX row+seed channels,
//! removals, stats, the FX seed stream and the RNG draw count are always exact.
//!
//! Every fixture replays twice: once handing the kernel every dynamic anchor
//! the fixture recorded, once only the ones the bridge would resolve (the
//! published NEED_* bits + emit clock + slot threshold, as
//! scene3d/rust/particles.js `tick` gates them) — a stale anchor the kernel
//! then read would show up as a bit difference. Both check the published
//! per-handle Q_* rows (`state_out`) against `emitter_state` and the film
//! samples (`film_samples`) against the slot snapshot.

mod common;
use common::*;
use holtburger_scene::particles::layout::*;
use holtburger_scene::particles::{Config, ParticleSystem, SortScratch, sort_back_to_front};
use holtburger_scene::rng::Rng;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const TRIG_TYPES: [f64; 6] = [4.0, 5.0, 6.0, 7.0, 9.0, 11.0];
const GONE: u32 = u32::MAX;

#[derive(Default)]
struct Acc {
    compared: usize,
    exact: usize,
    max_ulp: u32,
    max_vel_abs: f64,
}

fn u(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| v.as_f64().map(|f| f as u64).expect("number"))
}

fn f(v: &Value) -> f64 {
    v.as_f64().expect("number")
}

/// Compare instance floats; `vel` = indices (within `stride`) that are
/// velocities, `pos_like` = indices that may carry a trig ulp.
fn cmp_block(ctx: &str, got: &[f32], want: &[f32], stride: usize, trig: bool, vel: &[usize], exact_idx: &[usize], acc: &mut Acc) {
    assert_eq!(got.len(), want.len(), "{ctx}: length");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        acc.compared += 1;
        if g.to_bits() == w.to_bits() || (g.is_nan() && w.is_nan()) {
            acc.exact += 1;
            continue;
        }
        let k = i % stride;
        if !trig || exact_idx.contains(&k) {
            panic!("{ctx}[{i}] (elem {k}): got {g:e} ({:08x}) want {w:e} ({:08x})", g.to_bits(), w.to_bits());
        }
        if vel.contains(&k) {
            let d = (*g as f64 - *w as f64).abs();
            assert!(d <= 1e-3, "{ctx}[{i}] (velocity {k}): got {g:e} want {w:e} (|d| {d:e})");
            if d > acc.max_vel_abs {
                acc.max_vel_abs = d;
            }
        } else {
            let d = ulps_f32(*g, *w);
            assert!(d <= 1, "{ctx}[{i}] (elem {k}): got {g:e} want {w:e} ({d} ulps)");
            if d > acc.max_ulp {
                acc.max_ulp = d;
            }
        }
    }
}

/// The bridge's per-tick anchor gate (scene3d/rust/particles.js `tick` +
/// `dynamicInputs`): would JS resolve this dynamic emitter's anchor for the
/// coming tick? Reads what the kernel published (after the last tick / add /
/// stop / set) and this tick's flags.
fn bridge_wants_anchor(sys: &ParticleSystem, h: u32, now: f64, birthrate: f64) -> bool {
    let hu = h as usize;
    let need = sys.needs_anchor[hu];
    let want = if need & NEED_ALWAYS != 0 {
        true
    } else if need & (NEED_IF_DUE | NEED_IF_SLOT) != 0 {
        (need & NEED_IF_DUE == 0 || now - sys.anchor_last_emit[hu] > birthrate)
            && (need & NEED_IF_SLOT == 0 || now >= sys.anchor_slot_free[hu] - NEED_SLOT_MARGIN_US as f64 * 1e-6)
    } else {
        false
    };
    want && !(need & NEED_SKIP_IF_CULLED != 0 && sys.flags_in[hu] & FLAG_CULLED != 0)
}

fn run(name: &str) {
    replay(name, false);
    replay(name, true);
}

/// `gated`: write a recorded dynamic anchor only when `bridge_wants_anchor`.
fn replay(name: &str, gated: bool) {
    let Some(fx) = fixture(name) else {
        eprintln!("{name} fixture missing — run node tools/rust_parity/gen_particles.mjs (apps/holtburger-web)");
        return;
    };
    let label = if gated { format!("{name} (anchors gated)") } else { name.to_string() };
    let name = label.as_str();
    let cfg = Config::from_slice(&hex_f64s(&fx["config"]));
    let draws = hex_f64s(&fx["rng"]);
    let total_draws = draws.len();
    let mut sys = ParticleSystem::new(cfg, Rng::scripted(draws));
    let mut handle_of: Vec<u32> = Vec::new();
    let mut ptype_of: Vec<f64> = Vec::new();
    let mut route_of: Vec<usize> = Vec::new();
    let mut layer_of: Vec<u32> = Vec::new();
    let mut kids_of: Vec<bool> = Vec::new();
    let mut birthrate_of: Vec<f64> = Vec::new();
    let mut anchors_written = 0usize;
    let mut anchors_skipped = 0usize;
    let mut e_of_handle: HashMap<u32, usize> = HashMap::new();
    let mut known_layers: HashSet<u32> = HashSet::new();
    let mut acc = Acc::default();
    let mut sorter = SortScratch::default();
    let mut tick_no = 0usize;

    for op in fx["ops"].as_array().expect("ops") {
        match op["op"].as_str().expect("op") {
            "add" => {
                let e = u(&op["e"]) as usize;
                let d = hex_f64s(&op["desc"]);
                let h = sys.add_emitter(&d);
                assert_ne!(h, u32::MAX, "{name}: add_emitter rejected emitter {e}");
                if handle_of.len() <= e {
                    handle_of.resize(e + 1, GONE);
                    ptype_of.resize(e + 1, 0.0);
                    route_of.resize(e + 1, 0);
                    layer_of.resize(e + 1, 0);
                    kids_of.resize(e + 1, false);
                    birthrate_of.resize(e + 1, 0.0);
                }
                handle_of[e] = h;
                ptype_of[e] = d[D_PARTICLE_TYPE];
                route_of[e] = d[D_ROUTE] as usize;
                layer_of[e] = d[D_RENDER_LAYER] as u32;
                kids_of[e] = d[D_KIDS_ROW] != 0.0;
                birthrate_of[e] = d[D_BIRTHRATE];
                e_of_handle.insert(h, e);
            }
            "stop" => {
                let e = u(&op["e"]) as usize;
                assert!(sys.stop_emitter(handle_of[e]), "{name}: stop {e}");
            }
            "destroy" => {
                let e = u(&op["e"]) as usize;
                let h = handle_of[e];
                assert!(sys.remove_emitter(h), "{name}: destroy {e}");
                e_of_handle.remove(&h);
                handle_of[e] = GONE;
            }
            "set" => {
                let e = u(&op["e"]) as usize;
                let field = u(&op["field"]) as u32;
                assert!(sys.set_field(handle_of[e], field, hex_f64(&op["value"])), "{name}: set {e}.{field}");
            }
            "tick" => {
                tick_no += 1;
                let ctx = format!("{name} tick {tick_no}");
                let routes = hex_f64s(&op["routes"]);
                let keys = hex_f64s(&op["keys"]);
                sys.set_tables(routes.len() / ROUTE_STRIDE, keys.len() / KEY_STRIDE);
                sys.route_in.copy_from_slice(&routes);
                sys.key_in.copy_from_slice(&keys);
                let g = hex_f64s(&op["globals"]);
                // flags first: the bridge decides them before the anchor (dynamicInputs)
                for fl in op["flags"].as_array().expect("flags") {
                    let e = u(&fl[0]) as usize;
                    let h = handle_of[e];
                    if h != GONE {
                        sys.flags_in[h as usize] = u(&fl[1]) as u32;
                    }
                }
                for a in op["anchors"].as_array().expect("anchors") {
                    let e = u(&a[0]) as usize;
                    let h = handle_of[e];
                    if h == GONE {
                        continue;
                    }
                    if gated && !bridge_wants_anchor(&sys, h, g[G_NOW], birthrate_of[e]) {
                        anchors_skipped += 1;
                        continue;
                    }
                    anchors_written += 1;
                    let v = hex_f64s(&a[1]);
                    let o = h as usize * ANCHOR_STRIDE;
                    sys.anchor_in[o..o + ANCHOR_STRIDE].copy_from_slice(&v);
                }
                sys.tick(&g);
                let ex = &op["expect"];

                // ---- RNG, stats, FX seed ----
                assert_eq!(sys.rng().consumed(), Some(u(&ex["rngUsed"]) as usize), "{ctx}: RNG draws consumed");
                assert!(!sys.rng().overrun(), "{ctx}: RNG overrun");
                let st = sys.out.stats.clone();
                let es: Vec<f64> = ex["stats"].as_array().expect("stats").iter().map(f).collect();
                assert_eq!(st[S_FORCE_STOPPED], es[0], "{ctx}: culledForceStopped");
                assert_eq!(st[S_CELL_HIDDEN], es[1], "{ctx}: cellHiddenEmitterTicks");
                assert_eq!(st[S_CELL_PARTICLE_TICKS], es[2], "{ctx}: cellHiddenParticleTicks");
                assert_eq!(st[S_REJECTED_SCENE], es[3], "{ctx}: shared rejectedScene");
                assert_eq!(st[S_REJECTED_MAT], es[4], "{ctx}: shared rejectedMat");
                assert_eq!(st[S_CELL_HIDDEN], f(&ex["cellHidden"]), "{ctx}: cellHiddenLastTick");
                assert_eq!(st[S_FX_SEED] as u64, u(&ex["seed"]), "{ctx}: FX seed state");

                // ---- finished emitters, in table order ----
                let fin: Vec<i64> = sys.out.finished.iter().map(|h| e_of_handle.get(h).map(|e| *e as i64).unwrap_or(-1)).collect();
                let want_fin: Vec<i64> = ex["removed"].as_array().expect("removed").iter().map(|v| v.as_i64().expect("idx")).collect();
                assert_eq!(fin, want_fin, "{ctx}: finished emitters");
                for h in sys.out.finished.clone() {
                    if let Some(e) = e_of_handle.remove(&h) {
                        handle_of[e] = GONE;
                    }
                }

                // ---- events: creation order + capacities ----
                let nk = keys.len() / KEY_STRIDE;
                let kv = |k: usize, i: usize| keys[k * KEY_STRIDE + i];
                let mut own_exists: Vec<bool> = (0..nk).map(|k| kv(k, K_OWN_EXISTS) != 0.0).collect();
                let mut own_cap: Vec<f64> = (0..nk).map(|k| kv(k, K_OWN_CAP)).collect();
                let mut sh_exists: Vec<bool> = (0..nk).map(|k| kv(k, K_SH_EXISTS) != 0.0).collect();
                let mut sh_cap: Vec<f64> = (0..nk).map(|k| kv(k, K_SH_CAP)).collect();
                let mut created: Vec<(u64, u64)> = Vec::new();
                let mut kids_created: Vec<u64> = Vec::new();
                for ev in sys.out.events.chunks(EV_STRIDE) {
                    let (t, a, b) = (ev[0], ev[1] as usize, ev[2] as f64);
                    match t {
                        EV_OWN => {
                            if !own_exists[a] {
                                own_exists[a] = true;
                                own_cap[a] = 256.0;
                                created.push((0, a as u64));
                            }
                        }
                        EV_SHARED => {
                            if !sh_exists[a] {
                                sh_exists[a] = true;
                                sh_cap[a] = 256.0;
                                created.push((1, a as u64));
                            }
                        }
                        EV_GROW_OWN => {
                            while own_cap[a] < b {
                                own_cap[a] *= 2.0;
                            }
                        }
                        EV_GROW_SHARED => {
                            while sh_cap[a] < b {
                                sh_cap[a] *= 2.0;
                            }
                        }
                        EV_KIDS_LAYER => {
                            if known_layers.insert(a as u32) {
                                kids_created.push(a as u64);
                            }
                        }
                        _ => {}
                    }
                }
                let want_created: Vec<(u64, u64)> =
                    ex["created"].as_array().expect("created").iter().map(|c| (u(&c[0]), u(&c[1]))).collect();
                assert_eq!(created, want_created, "{ctx}: bucket creation order (kind, key)");
                let want_kc: Vec<u64> = ex["kidsCreated"].as_array().expect("kidsCreated").iter().map(u).collect();
                assert_eq!(kids_created, want_kc, "{ctx}: kids layer creation order");

                // ---- which keys / layers carry trig-derived values ----
                let mut trig_keys: HashSet<u64> = HashSet::new();
                let mut trig_layers: HashSet<u32> = HashSet::new();
                for (e, h) in handle_of.iter().enumerate() {
                    if *h == GONE || !TRIG_TYPES.contains(&ptype_of[e]) {
                        continue;
                    }
                    let r = route_of[e];
                    if r * ROUTE_STRIDE < routes.len() && routes[r * ROUTE_STRIDE] >= 0.0 {
                        trig_keys.insert(routes[r * ROUTE_STRIDE] as u64);
                    }
                    if kids_of[e] {
                        trig_layers.insert(layer_of[e]);
                    }
                }

                // ---- bucket contents ----
                let mut got: HashMap<(u32, u32), (usize, usize)> = HashMap::new();
                for b in sys.out.buckets.chunks(BK_STRIDE) {
                    got.insert((b[0], b[1]), (b[2] as usize, b[3] as usize));
                }
                for (kind, list) in [(BK_OWN, "own"), (BK_SHARED, "shared")] {
                    for b in ex[list].as_array().expect("buckets") {
                        let key = b["key"].as_i64().expect("key");
                        assert!(key >= 0, "{ctx}: {list} bucket with an unknown key");
                        let key = key as u32;
                        let want_n = u(&b["count"]) as usize;
                        let cap_now = if kind == BK_OWN { own_cap[key as usize] } else { sh_cap[key as usize] };
                        assert_eq!(cap_now, f(&b["cap"]), "{ctx}: {list} bucket {key} capacity");
                        let (n, first) = got.get(&(kind, key)).copied().unwrap_or((0, 0));
                        assert_eq!(n, want_n, "{ctx}: {list} bucket {key} count");
                        if n == 0 {
                            continue;
                        }
                        let mut mat = sys.out.mat[first * MAT_STRIDE..(first + n) * MAT_STRIDE].to_vec();
                        let mut col = sys.out.col[first * COL_STRIDE..(first + n) * COL_STRIDE].to_vec();
                        if kind == BK_SHARED && !ex["sharedSortCam"].is_null() {
                            let c = hex_f64s(&ex["sharedSortCam"]);
                            sort_back_to_front(&mut mat[..], Some(&mut col[..]), n, [c[0], c[1], c[2]], &mut sorter);
                        }
                        let trig = trig_keys.contains(&(key as u64));
                        cmp_block(&format!("{ctx} {list}[{key}].mat"), &mat, &hex_f32s(&b["mat"]), MAT_STRIDE, trig, &[3, 7, 11], &[15], &mut acc);
                        cmp_block(&format!("{ctx} {list}[{key}].col"), &col, &hex_f32s(&b["col"]), COL_STRIDE, false, &[], &[], &mut acc);
                    }
                }

                // ---- kid records ----
                let mut kid_got: HashMap<u32, (usize, usize)> = HashMap::new();
                for k in sys.out.kids.chunks(KL_STRIDE) {
                    kid_got.insert(k[0], (k[1] as usize, k[2] as usize));
                }
                let mut layers_now: HashSet<u32> = HashSet::new();
                for k in ex["kids"].as_array().expect("kids") {
                    let layer = u(&k["layer"]) as u32;
                    layers_now.insert(layer);
                    let want_n = u(&k["n"]) as usize;
                    let (n, first) = kid_got.get(&layer).copied().unwrap_or((0, 0));
                    assert_eq!(n, want_n, "{ctx}: kids layer {layer} records");
                    if n == 0 {
                        continue;
                    }
                    let data = &sys.out.kid_data[first * KID_STRIDE..(first + n) * KID_STRIDE];
                    let mut pos = Vec::with_capacity(n * 4);
                    let mut vel = Vec::with_capacity(n * 4);
                    let mut row = Vec::with_capacity(n * 2);
                    for r in data.chunks(KID_STRIDE) {
                        pos.extend_from_slice(&r[0..4]);
                        vel.extend_from_slice(&r[4..8]);
                        row.extend_from_slice(&r[8..10]);
                    }
                    let trig = trig_layers.contains(&layer);
                    cmp_block(&format!("{ctx} kids[{layer}].pos"), &pos, &hex_f32s(&k["pos"]), 4, trig, &[], &[3], &mut acc);
                    cmp_block(&format!("{ctx} kids[{layer}].vel"), &vel, &hex_f32s(&k["vel"]), 4, trig, &[0, 1, 2], &[3], &mut acc);
                    cmp_block(&format!("{ctx} kids[{layer}].row"), &row, &hex_f32s(&k["row"]), 2, false, &[], &[], &mut acc);
                }
                known_layers = layers_now;

                // ---- emitter scalars ----
                for em in ex["emitters"].as_array().expect("emitters") {
                    let e = em[0].as_i64().expect("idx");
                    assert!(e >= 0, "{ctx}: live emitter not in the fixture");
                    let h = handle_of[e as usize];
                    assert_ne!(h, GONE, "{ctx}: emitter {e} gone in Rust but live in JS");
                    // the row JS field reads see (published at the end of the tick)
                    let o = h as usize * Q_LEN;
                    let published = sys.state_out[o..o + Q_LEN].to_vec();
                    let q = sys.emitter_state(h);
                    assert_bits_eq(&format!("{ctx}: emitter {e} state_out vs emitter_state"), &published, &q);
                    assert_eq!(q[Q_NUM_PARTICLES], f(&em[1]), "{ctx}: emitter {e} numParticles");
                    assert_eq!(q[Q_TOTAL_EMITTED], f(&em[2]), "{ctx}: emitter {e} totalEmitted");
                    assert_eq!(q[Q_STOPPED], f(&em[3]), "{ctx}: emitter {e} stopped");
                    assert_eq!(q[Q_CULLED], f(&em[4]), "{ctx}: emitter {e} culled");
                }

                // ---- film samples = the first live, visible, finite slots above the floor ----
                check_film_samples(&mut sys, &ctx, 4, 0.02);
            }
            other => panic!("{name}: unknown op {other}"),
        }
    }
    assert_eq!(sys.rng().consumed(), Some(total_draws), "{name}: the kernel must consume every JS draw");
    eprintln!(
        "{name}: {tick_no} ticks, {} floats compared, {} bit-exact, max {} ulp (trig buckets), max velocity |d| {:e}, dynamic anchors {anchors_written} written / {anchors_skipped} gated off",
        acc.compared, acc.exact, acc.max_ulp, acc.max_vel_abs
    );
}

/// `film_samples(max, op_min)` against each live emitter's slot snapshot.
fn check_film_samples(sys: &mut ParticleSystem, ctx: &str, max: usize, op_min: f64) {
    sys.film_samples(max, op_min);
    let film = sys.film_out.clone();
    let mut i = 0usize;
    while i + 1 < film.len() {
        let h = film[i] as u32;
        let n = film[i + 1] as usize;
        assert!(n <= max, "{ctx}: film samples of handle {h}: {n} > {max}");
        let snap = sys.slot_snapshot(h);
        let mut want: Vec<f64> = Vec::new();
        let mut k = 0usize;
        for s in snap.chunks(SL_STRIDE) {
            if k >= max {
                break;
            }
            if s[SL_LIVE] != 1.0 || s[SL_VISIBLE] != 1.0 {
                continue;
            }
            let raw = if s[SL_OP].is_finite() { s[SL_OP] } else { 1.0 };
            if raw.clamp(0.0, 1.0) <= op_min {
                continue;
            }
            if !(s[SL_POS].is_finite() && s[SL_POS + 1].is_finite() && s[SL_POS + 2].is_finite()) {
                continue;
            }
            want.extend_from_slice(&[s[SL_POS], s[SL_POS + 1], s[SL_POS + 2], s[SL_SCALE], s[SL_OP]]);
            k += 1;
        }
        assert_bits_eq(&format!("{ctx}: film samples of handle {h}"), &film[i + 2..i + 2 + n * FS_STRIDE], &want);
        i += 2 + n * FS_STRIDE;
    }
    assert_eq!(i, film.len(), "{ctx}: film_out framing");
}

/// A minimal descriptor (layout D_*): a persistent per-second emitter at the
/// origin with `burst` initial particles and every slot created.
fn simple_desc(id: f64, burst: f64) -> Vec<f64> {
    let mut d = vec![0.0; D_LEN];
    d[D_ID] = id;
    d[D_EMITTER_TYPE] = 1.0;
    d[D_PARTICLE_TYPE] = 2.0;
    d[D_BIRTHRATE] = 0.05;
    d[D_MAX_PARTICLES] = 8.0;
    d[D_LIFESPAN] = 1.0;
    d[D_START_SCALE] = 1.0;
    d[D_FINAL_SCALE] = 1.0;
    d[D_PO_QUAT + 3] = 1.0;
    d[D_ANCHOR_QUAT + 3] = 1.0;
    d[D_CREATED_SLOTS] = 8.0;
    d[D_INIT_NOW] = 100.0;
    d[D_BURST] = burst;
    d[D_RP6_RADIUS] = -1.0;
    d
}

/// Live emitters in tick order (film_out lists them in that order).
fn tick_order(sys: &mut ParticleSystem) -> Vec<u32> {
    sys.film_samples(0, 0.0);
    let film = &sys.film_out;
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 1 < film.len() {
        out.push(film[i] as u32);
        i += 2 + film[i + 1] as usize * FS_STRIDE;
    }
    out
}

/// `add_emitter_at` (an in-place table overwrite's newcomer): placed before
/// `before` in the tick order, a freed handle reused next to a dead entry,
/// an unknown `before` appends; the published rows follow the handles.
#[test]
fn particles_add_at_tick_order_and_handles() {
    let mut sys = ParticleSystem::new(Config::default(), Rng::seeded(7));
    let a = sys.add_emitter(&simple_desc(1.0, 2.0));
    let b = sys.add_emitter(&simple_desc(2.0, 2.0));
    let c = sys.add_emitter(&simple_desc(3.0, 2.0));
    assert_eq!(tick_order(&mut sys), vec![a, b, c]);
    let d = sys.add_emitter_at(&simple_desc(4.0, 2.0), b);
    assert_eq!(tick_order(&mut sys), vec![a, d, b, c]);
    // `a` removed (dead until the next tick compacts) and its handle reused
    assert!(sys.remove_emitter(a));
    let e = sys.add_emitter_at(&simple_desc(5.0, 3.0), c);
    assert_eq!(e, a, "the freed handle is reused");
    assert_eq!(tick_order(&mut sys), vec![d, b, e, c]);
    assert!(sys.stop_emitter(e), "the reused handle reaches the new emitter");
    assert_eq!(sys.state_out[e as usize * Q_LEN + Q_STOPPED], 1.0);
    assert_eq!(sys.state_out[d as usize * Q_LEN + Q_STOPPED], 0.0);
    assert_eq!(sys.state_out[e as usize * Q_LEN + Q_NUM_PARTICLES], 3.0);
    let g = sys.add_emitter_at(&simple_desc(6.0, 1.0), 999);
    assert_eq!(tick_order(&mut sys), vec![d, b, e, c, g]);
    for h in [d, b, e, c, g] {
        let o = h as usize * Q_LEN;
        let row = sys.state_out[o..o + Q_LEN].to_vec();
        let q = sys.emitter_state(h);
        assert_bits_eq(&format!("state_out[{h}]"), &row, &q);
    }
    assert_eq!(sys.emitter_count(), 5);
}

#[test]
fn particles_types() {
    run("particles_types");
}

#[test]
fn particles_facing() {
    run("particles_facing");
}

#[test]
fn particles_cull() {
    run("particles_cull");
}

#[test]
fn particles_dynamic() {
    run("particles_dynamic");
}

#[test]
fn particles_grow() {
    run("particles_grow");
}

#[test]
fn particles_legacy() {
    run("particles_legacy");
}

/// The JS-side shared-bucket sort helper equals the kernel sort (and V8's).
#[test]
fn particles_sort_scratch_helper_matches() {
    let mut sys = ParticleSystem::new(Config::default(), Rng::seeded(1));
    let n = 37;
    sys.sort_scratch_reserve(n);
    let mut mat = vec![0.0f32; n * 16];
    let mut col = vec![0.0f32; n * 3];
    let mut r = Rng::seeded(9);
    for i in 0..n {
        for k in 0..16 {
            mat[i * 16 + k] = (r.next_f64() * 10.0 - 5.0) as f32;
        }
        // a few exact ties
        if i % 5 == 0 {
            mat[i * 16 + 12] = 1.0;
            mat[i * 16 + 13] = 2.0;
            mat[i * 16 + 14] = 3.0;
        }
        col[i * 3] = i as f32;
    }
    sys.sort_mat.copy_from_slice(&mat);
    sys.sort_col.copy_from_slice(&col);
    sys.sort_scratch_run(n, [0.5, -0.25, 1.0], true);
    let mut sc = SortScratch::default();
    sort_back_to_front(&mut mat[..], Some(&mut col[..]), n, [0.5, -0.25, 1.0], &mut sc);
    assert_eq!(sys.sort_mat, mat);
    assert_eq!(sys.sort_col, col);
    // far first, ties in their input order
    let key = |i: usize| {
        let (x, y, z) = (mat[i * 16 + 12] as f64 - 0.5, mat[i * 16 + 13] as f64 + 0.25, mat[i * 16 + 14] as f64 - 1.0);
        (x * x + y * y + z * z) as f32
    };
    for i in 1..n {
        assert!(key(i - 1) >= key(i));
        if key(i - 1) == key(i) {
            assert!(col[(i - 1) * 3] < col[i * 3]);
        }
    }
}
