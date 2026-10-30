//! The instanced-bucket side of particle_manager.js `_appendInstances` for
//! one manager tick: which bucket an emitter appends to (its own
//! `_instBuckets` entry or the module-level shared alpha bucket of
//! `?particleSharedAlpha`), when JS must create / acquire / grow a bucket
//! (recorded as ordered events so three.js objects are created in the same
//! order as the JS path), and the per-bucket instance data written this tick.
//!
//! JS hands in, per bucket key, the state of the buckets that exist at the
//! start of the tick (`key_in`, see layout.rs); the kernel then follows the
//! JS decisions exactly: `sharedAlphaBuckets.acquire` (create, reject on a
//! different scene or material signature, else share), the own-bucket
//! fallback, and `_growBucket`'s doubling from the current capacity.

use super::layout::*;
use super::sort::{SortScratch, sort_back_to_front};

/// `_INST_BUCKET_MIN_CAP`.
pub const BUCKET_MIN_CAP: f64 = 256.0;

#[derive(Clone, Debug, Default)]
struct KeyState {
    own_exists: bool,
    own_cap: f64,
    own_n: f64,
    own_fx: bool,
    own_used: Option<usize>,
    sh_exists: bool,
    sh_sig: u32,
    sh_scene_ok: bool,
    sh_cap: f64,
    sh_n: f64,
    sh_fx: bool,
    sh_used: Option<usize>,
    alpha: bool,
}

/// One bucket written this tick (first-use order).
#[derive(Clone, Debug, Default)]
pub struct Used {
    pub kind: u32,
    pub key: u32,
    pub mat: Vec<f32>,
    pub col: Vec<f32>,
}

impl Used {
    pub fn count(&self) -> usize {
        self.mat.len() / MAT_STRIDE
    }
}

/// Where one emitter's instances go this tick.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub used: usize,
    pub fx: bool,
    /// The bucket's `n` before this emitter and its capacity after any grow.
    pub n: f64,
    pub cap: f64,
}

#[derive(Default, Debug)]
pub struct BucketTick {
    keys: Vec<KeyState>,
    used: Vec<Used>,
    used_len: usize,
    pub rejected_scene: f64,
    pub rejected_mat: f64,
    sort: SortScratch,
}

impl BucketTick {
    /// Reset for a tick from `key_in` (KEY_STRIDE f64 per key).
    pub fn begin(&mut self, key_in: &[f64]) {
        let nk = key_in.len() / KEY_STRIDE;
        self.keys.clear();
        for k in 0..nk {
            let r = &key_in[k * KEY_STRIDE..k * KEY_STRIDE + KEY_STRIDE];
            self.keys.push(KeyState {
                own_exists: r[K_OWN_EXISTS] != 0.0,
                own_cap: r[K_OWN_CAP],
                own_n: 0.0,
                own_fx: r[K_OWN_FX] != 0.0,
                own_used: None,
                sh_exists: r[K_SH_EXISTS] != 0.0,
                sh_sig: r[K_SH_SIG] as u32,
                sh_scene_ok: r[K_SH_SCENE_OK] != 0.0,
                sh_cap: r[K_SH_CAP],
                sh_n: r[K_SH_START_N],
                sh_fx: r[K_SH_FX] != 0.0,
                sh_used: None,
                alpha: r[K_ALPHA] != 0.0,
            });
        }
        for u in self.used.iter_mut() {
            u.mat.clear();
            u.col.clear();
        }
        self.used_len = 0;
        self.rejected_scene = 0.0;
        self.rejected_mat = 0.0;
    }

    fn take_used(&mut self, kind: u32, key: u32) -> usize {
        let i = self.used_len;
        if i == self.used.len() {
            self.used.push(Used::default());
        }
        let u = &mut self.used[i];
        u.kind = kind;
        u.key = key;
        u.mat.clear();
        u.col.clear();
        self.used_len += 1;
        i
    }

    /// `_appendInstances`' bucket lookup + grow for one emitter: returns the
    /// target, or None when the key is unknown (JS never registered it).
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        &mut self,
        key: u32,
        sig: u32,
        shared_eligible: bool,
        shared_on: bool,
        fx_if_create: bool,
        fx_enabled: bool,
        handle: u32,
        num_particles: f64,
        events: &mut Vec<u32>,
    ) -> Option<Target> {
        let k = key as usize;
        if k >= self.keys.len() {
            return None;
        }
        let mut shared = false;
        if shared_eligible && shared_on {
            let ks = &mut self.keys[k];
            if !ks.sh_exists {
                // acquire() creates it (through this emitter) and accepts it.
                events.extend_from_slice(&[EV_SHARED, key, handle]);
                ks.sh_exists = true;
                ks.sh_sig = sig;
                ks.sh_scene_ok = true;
                ks.sh_cap = BUCKET_MIN_CAP;
                ks.sh_n = 0.0;
                ks.sh_fx = fx_if_create && fx_enabled;
                shared = true;
            } else if !ks.sh_scene_ok {
                self.rejected_scene += 1.0;
            } else if ks.sh_sig != sig {
                self.rejected_mat += 1.0;
            } else {
                if ks.sh_used.is_none() {
                    // acquire() on an existing bucket: frame reset + idle = 0.
                    events.extend_from_slice(&[EV_SHARED, key, handle]);
                }
                shared = true;
            }
        }
        if shared {
            let cur = self.keys[k].sh_used;
            let used = match cur {
                Some(u) => u,
                None => {
                    let u = self.take_used(BK_SHARED, key);
                    self.keys[k].sh_used = Some(u);
                    u
                }
            };
            let ks = &mut self.keys[k];
            let need = ks.sh_n + num_particles;
            if need > ks.sh_cap {
                events.extend_from_slice(&[EV_GROW_SHARED, key, need as u32]);
                let mut cap = ks.sh_cap;
                while cap < need {
                    cap *= 2.0;
                }
                ks.sh_cap = cap;
            }
            return Some(Target { used, fx: ks.sh_fx, n: ks.sh_n, cap: ks.sh_cap });
        }
        if !self.keys[k].own_exists {
            events.extend_from_slice(&[EV_OWN, key, handle]);
            let ks = &mut self.keys[k];
            ks.own_exists = true;
            ks.own_cap = BUCKET_MIN_CAP;
            ks.own_n = 0.0;
            ks.own_fx = fx_if_create && fx_enabled;
        }
        let cur = self.keys[k].own_used;
        let used = match cur {
            Some(u) => u,
            None => {
                let u = self.take_used(BK_OWN, key);
                self.keys[k].own_used = Some(u);
                u
            }
        };
        let ks = &mut self.keys[k];
        let need = ks.own_n + num_particles;
        if need > ks.own_cap {
            events.extend_from_slice(&[EV_GROW_OWN, key, need as u32]);
            let mut cap = ks.own_cap;
            while cap < need {
                cap *= 2.0;
            }
            ks.own_cap = cap;
        }
        Some(Target { used, fx: ks.own_fx, n: ks.own_n, cap: ks.own_cap })
    }

    /// The instance buffers of a target (to append to).
    pub fn buffers(&mut self, t: &Target) -> (&mut Vec<f32>, &mut Vec<f32>) {
        let u = &mut self.used[t.used];
        (&mut u.mat, &mut u.col)
    }

    /// Record the bucket's `n` after an emitter's appends.
    pub fn set_n(&mut self, t: &Target, n: f64) {
        let u = &self.used[t.used];
        let (kind, k) = (u.kind, u.key as usize);
        let ks = &mut self.keys[k];
        if kind == BK_SHARED {
            ks.sh_n = n;
        } else {
            ks.own_n = n;
        }
    }

    /// `_finalizeInstBuckets`' back-to-front sort of the own ALPHA buckets
    /// (shared alpha buckets are sorted by JS, over every manager's instances).
    pub fn sort_own_alpha(&mut self, cam: [f64; 3]) {
        for i in 0..self.used_len {
            let (kind, k) = (self.used[i].kind, self.used[i].key as usize);
            if kind != BK_OWN || !self.keys[k].alpha {
                continue;
            }
            let u = &mut self.used[i];
            let n = u.mat.len() / MAT_STRIDE;
            sort_back_to_front(&mut u.mat[..], Some(&mut u.col[..]), n, cam, &mut self.sort);
        }
    }

    pub fn used(&self) -> &[Used] {
        &self.used[..self.used_len]
    }
}
