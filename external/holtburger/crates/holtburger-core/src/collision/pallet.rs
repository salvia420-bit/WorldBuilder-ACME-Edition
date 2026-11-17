use glam::Vec3;

pub struct PalletCollider {
    pub center: Vec3,
    pub extents: Vec3,
    pub rotation: glam::Quat,
}

impl PalletCollider {
    pub fn new(center: Vec3, extents: Vec3, rotation: glam::Quat) -> Self {
        Self { center, extents, rotation }
    }
    
    /// Checks if a point (e.g., player foot position) is inside the pallet collider.
    pub fn intersects_point(&self, point: Vec3) -> bool {
        let local_point = self.rotation.inverse() * (point - self.center);
        local_point.x.abs() <= self.extents.x &&
        local_point.y.abs() <= self.extents.y &&
        local_point.z.abs() <= self.extents.z
    }
}
