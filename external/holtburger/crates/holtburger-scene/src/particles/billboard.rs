//! particle_manager.js `_billboardEmitter` (synthesized `info.billboard`
//! sprites) and `_billboardEmitterRetail` (retail deg_mode 2..5 facing) for
//! instanced emitters. Both write only the slot quaternion. On the instanced
//! path the slot meshes are scene-detached carriers (`mesh.parent === null`),
//! so the sprite pass compares the camera's `position` with the carrier's
//! local position and applies no parent rotation — reproduced as is.

use super::particle::Slot;
use super::three_ext::{add_scaled, make_basis, quat_from_unit_vectors};
use crate::math::{Quat, Vec3};

/// `_billboardEmitter(emitter, camera)` over one emitter's slots.
pub fn sprite(slots: &mut [Slot], normal: Option<Vec3>, cam: Vec3) {
    for s in slots.iter_mut() {
        if !s.live || !s.visible {
            continue;
        }
        let Some(n_local) = normal else { continue };
        // parent === null: _bbMeshWorld.copy(mesh.position)
        let mut dir = cam.sub(s.pos);
        if dir.length_sq() < 1e-10 {
            continue;
        }
        dir = dir.normalize();
        s.quat = quat_from_unit_vectors(n_local, dir);
    }
}

/// `_billboardEmitterRetail(emitter, camera, mode, scene)`; `cam_local` is
/// `camera.position` in `_scene`-local space (computed once per tick by JS
/// with the same `copy(scene.matrixWorld).invert()` + `applyMatrix4`).
pub fn retail(slots: &mut [Slot], mode: u32, cam_local: Vec3) {
    for s in slots.iter_mut() {
        if !s.live || !s.visible {
            continue;
        }
        let mut dir = s.pos.sub(cam_local);
        if dir.length_sq() < 1e-10 {
            continue;
        }
        dir = dir.normalize();
        if mode == 2 {
            // Full billboard: aim +Y = dir, roll 0 (local Z stays closest to up).
            let mut aim = add_scaled(Vec3::new(0.0, 0.0, 1.0), dir, -dir.z);
            if aim.length_sq() < 1e-10 {
                continue;
            }
            aim = aim.normalize();
            let third = dir.cross(aim);
            let basis = make_basis(third, dir, aim);
            s.quat = Quat::from_rotation_matrix(&basis);
            continue;
        }
        let keep0 = if mode == 5 {
            Vec3::new(0.0, 0.0, 1.0)
        } else if mode == 4 {
            Vec3::new(0.0, 1.0, 0.0)
        } else {
            Vec3::new(1.0, 0.0, 0.0)
        };
        let keep = keep0.apply_quat(s.quat).normalize();
        let mut aim = add_scaled(dir, keep, -dir.dot(keep));
        if aim.length_sq() < 1e-10 {
            continue;
        }
        aim = aim.normalize();
        let third = aim.cross(keep);
        let basis = if mode == 5 {
            make_basis(third, aim, keep)
        } else if mode == 4 {
            make_basis(aim, keep, third)
        } else {
            make_basis(keep, third, aim)
        };
        s.quat = Quat::from_rotation_matrix(&basis);
    }
}
