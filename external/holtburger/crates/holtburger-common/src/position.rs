use crate::guid::Guid;
use crate::math::{Quaternion, Vector3};
use serde::{Deserialize, Serialize};

pub const METERS_PER_LANDBLOCK: f32 = 192.0;
pub const METERS_PER_MAP_DEGREE: f32 = 240.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct WorldPosition {
    pub landblock_id: Guid,
    pub coords: Vector3,
    pub rotation: Quaternion,
}

impl WorldPosition {}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum WorldCoordinates {
    Indoor {
        landblock: u16,
    },
    Outdoor {
        lat: f32, // North is positive, South is negative
        lon: f32, // East is positive, West is negative
        alt: f32,
    },
}

impl WorldCoordinates {
    pub fn to_string_with_precision(&self, precision: usize) -> String {
        match self {
            WorldCoordinates::Indoor { landblock } => format!("Indoors [{:04X}]", landblock),
            WorldCoordinates::Outdoor { lat, lon, alt } => {
                let ns = if *lat >= 0.0 { "N" } else { "S" };
                let ew = if *lon >= 0.0 { "E" } else { "W" };

                // ACE uses a 0.05 nudge when formatting to 1 decimal place to round down .X5 to .X
                let display_lat = if precision == 1 {
                    lat.abs() - 0.05
                } else {
                    lat.abs()
                };
                let display_lon = if precision == 1 {
                    lon.abs() - 0.05
                } else {
                    lon.abs()
                };

                format!(
                    "{:.*}{}, {:.*}{}, {:.1}Z",
                    precision, display_lat, ns, precision, display_lon, ew, alt
                )
            }
        }
    }
}

impl std::fmt::Display for WorldCoordinates {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_string_with_precision(1))
    }
}

impl WorldPosition {
    pub fn global_coords(&self) -> Vector3 {
        let (landblock_x, landblock_y) = self.landblock_coords();

        Vector3::new(
            (landblock_x as f32 * METERS_PER_LANDBLOCK) + self.coords.x,
            (landblock_y as f32 * METERS_PER_LANDBLOCK) + self.coords.y,
            self.coords.z,
        )
    }

    pub fn is_indoors(&self) -> bool {
        // In Asheron's Call, the low 16 bits of the landblock ID contain the cell.
        // Cell IDs 0x0000 - 0x003F are used for the 64 outdoor cells in a landblock.
        // Cell IDs 0x0100 and above are used for indoor/dungeon cells.
        (self.landblock_id & 0xFFFF) >= 0x0100
    }

    pub fn landblock_coords(&self) -> (u8, u8) {
        // X = Longitude byte, Y = Latitude byte (high word of Landblock ID)
        let x = ((self.landblock_id >> 24) & 0xFF) as u8;
        let y = ((self.landblock_id >> 16) & 0xFF) as u8;
        (x, y)
    }

    pub fn derived_outdoor_cell_id(&self) -> Option<u32> {
        if self.landblock_id == Guid::NULL || self.is_indoors() {
            return None;
        }

        // ACE derives outdoor cell ids from the local 0-192 block coordinates.
        let max_local = METERS_PER_LANDBLOCK - 1e-4;
        let local_x = self.coords.x.clamp(0.0, max_local);
        let local_y = self.coords.y.clamp(0.0, max_local);
        let cell_length = METERS_PER_LANDBLOCK / 8.0;
        let cell_x = (local_x / cell_length) as u32;
        let cell_y = (local_y / cell_length) as u32;

        Some((cell_x * 8) + cell_y + 1)
    }

    pub fn normalize_outdoor_cell(mut self) -> Self {
        let Some(cell_id) = self.derived_outdoor_cell_id() else {
            return self;
        };

        self.landblock_id = Guid((self.landblock_id.0 & 0xFFFF_0000) | cell_id);
        self
    }

    /// Phase 4 step 3.7 — re-bucket an outdoor pose whose local coords
    /// have advanced past `[0, METERS_PER_LANDBLOCK)`. Used by the wasm
    /// bundle's local-pose integrator (`MovementSystem::advance_local_
    /// pose_for_manual_drive`) when the player walks across a 192 m
    /// landblock boundary — the cli's full physics solver handles this
    /// implicitly via `SpatialPhysics::solve` + `apply_solved_body_
    /// kinematics`, but the wasm bundle skips the solver to keep the
    /// bundle small.
    ///
    /// Updates the high word of `landblock_id` (X = bits 24-31, Y = 16-23)
    /// by floor-dividing the absolute global coords through
    /// `METERS_PER_LANDBLOCK`, wraps `coords.{x, y}` back into
    /// `[0, METERS_PER_LANDBLOCK)`, and re-derives the cell id via
    /// [`Self::normalize_outdoor_cell`]. No-op if the pose is indoor or
    /// already in-bounds. Edge of the world (X or Y at 0 / 255) clamps
    /// rather than wrapping further — saves crashing if the integrator
    /// runs away.
    pub fn rebucket_outdoor_landblock(mut self) -> Self {
        if self.is_indoors() || self.landblock_id == Guid::NULL {
            return self;
        }

        let mut x = self.coords.x;
        let mut y = self.coords.y;
        let (mut lb_x, mut lb_y) = self.landblock_coords();
        let mut moved = false;

        while x >= METERS_PER_LANDBLOCK && lb_x < 0xFF {
            lb_x += 1;
            x -= METERS_PER_LANDBLOCK;
            moved = true;
        }
        while x < 0.0 && lb_x > 0 {
            lb_x -= 1;
            x += METERS_PER_LANDBLOCK;
            moved = true;
        }
        if x < 0.0 || x >= METERS_PER_LANDBLOCK {
            x = x.clamp(0.0, METERS_PER_LANDBLOCK - 1e-4);
        }

        while y >= METERS_PER_LANDBLOCK && lb_y < 0xFF {
            lb_y += 1;
            y -= METERS_PER_LANDBLOCK;
            moved = true;
        }
        while y < 0.0 && lb_y > 0 {
            lb_y -= 1;
            y += METERS_PER_LANDBLOCK;
            moved = true;
        }
        if y < 0.0 || y >= METERS_PER_LANDBLOCK {
            y = y.clamp(0.0, METERS_PER_LANDBLOCK - 1e-4);
        }

        if !moved {
            return self;
        }

        self.coords.x = x;
        self.coords.y = y;
        let cell_word = self.landblock_id.0 & 0xFFFF;
        self.landblock_id =
            Guid(((lb_x as u32) << 24) | ((lb_y as u32) << 16) | cell_word);
        self.normalize_outdoor_cell()
    }

    pub fn landblock_chebyshev_distance_to(&self, other: &Self) -> Option<u8> {
        if self.landblock_id == Guid::NULL || other.landblock_id == Guid::NULL {
            return None;
        }

        let (self_x, self_y) = self.landblock_coords();
        let (other_x, other_y) = other.landblock_coords();

        Some(self_x.abs_diff(other_x).max(self_y.abs_diff(other_y)))
    }

    pub fn cell_coords(&self) -> (u8, u8) {
        if self.is_indoors() {
            return (0, 0); // Indoor cells don't have a 2d grid layout in the same way
        }
        let cell_id = (self.landblock_id & 0xFFFF) as i32;
        let cell_index = cell_id - 1;
        if !(0..64).contains(&cell_index) {
            // For block-only landblocks (low word 0xFFFF), x/y is 0
            return (0, 0);
        }
        let cx = ((cell_index >> 3) & 0x7) as u8;
        let cy = (cell_index & 0x7) as u8;
        (cx, cy)
    }

    pub fn to_world_coords(&self) -> WorldCoordinates {
        if self.is_indoors() {
            return WorldCoordinates::Indoor {
                landblock: (self.landblock_id & 0xFFFF) as u16,
            };
        }

        let (lb_x, lb_y) = self.landblock_coords();

        // 1 landblock = 192 meters = 0.8 degrees.
        // 1 degree = 240 meters.
        // The local coords (self.coords.x/y) in an outdoor WorldPosition are 0-192.
        // They are relative to the landblock origin, NOT the cell origin.

        let total_x_meters = (lb_x as f32 * METERS_PER_LANDBLOCK) + self.coords.x;
        let total_y_meters = (lb_y as f32 * METERS_PER_LANDBLOCK) + self.coords.y;

        // Formula from ACE (PositionExtensions.GetMapCoords):
        // 1 map unit = 240 meters
        // mapCoords = globalPos / 240.0
        // mapCoords -= 102.0
        let lon = (total_x_meters / METERS_PER_MAP_DEGREE) - 102.0;
        let lat = (total_y_meters / METERS_PER_MAP_DEGREE) - 102.0;

        WorldCoordinates::Outdoor {
            lat,
            lon,
            alt: self.coords.z,
        }
    }

    pub fn distance_to(&self, other: &Self) -> f32 {
        if self.landblock_id == other.landblock_id {
            return self.coords.distance(&other.coords);
        }

        // Global-space distance in meters.
        // Mirrors ACE Position.DistanceTo semantics, which use landblock offsets for
        // both outdoor and indoor cells.
        let delta = self.global_coords() - other.global_coords();

        delta.length()
    }

    pub fn heading_to(&self, other: &Self) -> f32 {
        if self.landblock_id == other.landblock_id {
            return self.coords.heading_to(&other.coords);
        }

        self.global_coords().heading_to(&other.global_coords())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rebucket_outdoor_no_op_when_inside_bounds() {
        // Holtburg town center, well inside [0, 192) — should be unchanged.
        let pos = WorldPosition {
            landblock_id: Guid(0xA9B40019),
            coords: Vector3::new(84.0, 7.1, 94.0),
            rotation: Quaternion::identity(),
        };
        let r = pos.rebucket_outdoor_landblock();
        assert_eq!(r.landblock_id, Guid(0xA9B40019));
        assert!((r.coords.x - 84.0).abs() < 1e-3);
        assert!((r.coords.y - 7.1).abs() < 1e-3);
    }

    #[test]
    fn test_rebucket_outdoor_crosses_north() {
        // Walking north (Y increasing) past 192 should bump lb_y by 1
        // and wrap Y back into [0, 192). Start: lb=0xA9B4 (X=0xA9, Y=0xB4),
        // local Y = 200. After rebucket: lb=0xA9B5, Y=8.
        let pos = WorldPosition {
            landblock_id: Guid(0xA9B40019),
            coords: Vector3::new(94.0, 200.0, 94.0),
            rotation: Quaternion::identity(),
        };
        let r = pos.rebucket_outdoor_landblock();
        let (lb_x, lb_y) = r.landblock_coords();
        assert_eq!(lb_x, 0xA9, "X unchanged");
        assert_eq!(lb_y, 0xB5, "Y incremented (north)");
        assert!((r.coords.y - 8.0).abs() < 1e-3, "Y wrapped: got {}", r.coords.y);
    }

    #[test]
    fn test_rebucket_outdoor_crosses_south_west_diagonal() {
        // Walking south-west: y → -10, x → -50. lb_y goes from 0xB4 to 0xB3,
        // lb_x goes from 0xA9 to 0xA8, coords wrap to (142, 182).
        let pos = WorldPosition {
            landblock_id: Guid(0xA9B40019),
            coords: Vector3::new(-50.0, -10.0, 94.0),
            rotation: Quaternion::identity(),
        };
        let r = pos.rebucket_outdoor_landblock();
        let (lb_x, lb_y) = r.landblock_coords();
        assert_eq!(lb_x, 0xA8, "X decremented (west)");
        assert_eq!(lb_y, 0xB3, "Y decremented (south)");
        assert!((r.coords.x - 142.0).abs() < 1e-3, "X wrapped: got {}", r.coords.x);
        assert!((r.coords.y - 182.0).abs() < 1e-3, "Y wrapped: got {}", r.coords.y);
    }

    #[test]
    fn test_rebucket_outdoor_recomputes_cell_id() {
        // After rebucketing, the cell index in the low word should
        // match the new local coords. Pre: cell 0x19 (=25) at (84, 7).
        // Walking 200 m north: pose lands at (84, 15) in lb 0xA9B5.
        // Cell for (84, 15) = (cellX * 8) + cellY + 1 where
        // cellX = floor(84/24) = 3, cellY = floor(15/24) = 0
        // → (3*8) + 0 + 1 = 25 → 0x19.
        let pos = WorldPosition {
            landblock_id: Guid(0xA9B40019),
            coords: Vector3::new(84.0, 207.0, 94.0),
            rotation: Quaternion::identity(),
        };
        let r = pos.rebucket_outdoor_landblock();
        assert_eq!(
            r.landblock_id,
            Guid(0xA9B50019),
            "expected lb=0xA9B5, cell=0x19; got 0x{:08X}",
            r.landblock_id.0,
        );
    }

    #[test]
    fn test_rebucket_indoor_is_noop() {
        let pos = WorldPosition {
            landblock_id: Guid(0x860201AD), // indoor (low >= 0x100)
            coords: Vector3::new(12.32, -28.48, 0.005),
            rotation: Quaternion::identity(),
        };
        let r = pos.rebucket_outdoor_landblock();
        assert_eq!(r.landblock_id, Guid(0x860201AD));
        assert!((r.coords.x - 12.32).abs() < 1e-3);
        assert!((r.coords.y - (-28.48)).abs() < 1e-3);
    }

    #[test]
    fn test_indoor_format() {
        let pos = WorldPosition {
            landblock_id: Guid(0x00000100),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        assert!(pos.is_indoors());
        assert_eq!(
            pos.to_world_coords(),
            WorldCoordinates::Indoor { landblock: 0x0100 }
        );
        assert_eq!(pos.to_world_coords().to_string(), "Indoors [0100]");
    }

    #[test]
    fn test_outdoor_format_known() {
        // Construct landblock bytes x=218 (0xDA), y=85 (0x55)
        // Global Y = 85 * 192 + 108 = 16428. Lat = 16428/240 - 102 = -33.55 (33.55S)
        // Global X = 218 * 192 + 84 = 41940. Lon = 41940/240 - 102 = 72.75 (72.75E)
        let landblock_id = (218u32 << 24) | (85u32 << 16);
        let pos = WorldPosition {
            landblock_id: Guid(landblock_id),
            coords: Vector3::new(84.0, 108.0, 0.0),
            rotation: Quaternion::identity(),
        };
        assert!(!pos.is_indoors());

        let coords = pos.to_world_coords();
        if let WorldCoordinates::Outdoor { lat, lon, alt: _ } = coords {
            assert!((lat - (-33.55)).abs() < 1e-4, "Lat was {}", lat);
            assert!((lon - 72.75).abs() < 1e-4, "Lon was {}", lon);
        } else {
            panic!("Expected outdoor coordinates");
        }
        // With precision 2, should be:
        assert_eq!(coords.to_string_with_precision(2), "33.55S, 72.75E, 0.0Z");
    }

    #[test]
    fn test_distance_between_adjacent_cells() {
        let lb = (0xDAu32 << 24) | (0x55u32 << 16);
        // Cell 0x1C (index 27): X=3, Y=3.
        let pos1 = WorldPosition {
            landblock_id: Guid(lb | 0x1C),
            coords: Vector3::new(84.0, 84.0, 0.0), // Abs X = 218*192 + 84
            rotation: Quaternion::identity(),
        };
        // Cell 0x1D (index 28): X=3, Y=4.
        let pos2 = WorldPosition {
            landblock_id: Guid(lb | 0x1D),
            coords: Vector3::new(84.0, 100.0, 0.0), // Abs X = 218*192 + 84, Y = 218*192 + 100
            rotation: Quaternion::identity(),
        };

        // Distance should be exactly 16m (difference in Y coordinates)
        let dist = pos1.distance_to(&pos2);
        assert!((dist - 16.0).abs() < 1e-4, "Distance was {}", dist);
    }

    #[test]
    fn test_distance_same_and_adjacent() {
        let lb = (1u32 << 24) | (2u32 << 16);
        let p1 = WorldPosition {
            landblock_id: Guid(lb),
            coords: Vector3::new(0.0, 0.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let p2 = WorldPosition {
            landblock_id: Guid(lb),
            coords: Vector3::new(3.0, 4.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let d = p1.distance_to(&p2);
        assert!((d - 5.0).abs() < 1e-6);

        let p3 = WorldPosition {
            landblock_id: Guid(1u32 << 24),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let p4 = WorldPosition {
            landblock_id: Guid(0u32),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let d2 = p3.distance_to(&p4);
        assert!((d2 - 192.0).abs() < 1e-6);
    }

    #[test]
    fn test_landblock_chebyshev_distance_to_adjacent_block() {
        let p1 = WorldPosition {
            landblock_id: Guid(0x01010000),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let p2 = WorldPosition {
            landblock_id: Guid(0x02020000),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };

        assert_eq!(p1.landblock_chebyshev_distance_to(&p2), Some(1));
    }

    #[test]
    fn test_landblock_chebyshev_distance_to_two_blocks_away() {
        let p1 = WorldPosition {
            landblock_id: Guid(0x01010000),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let p2 = WorldPosition {
            landblock_id: Guid(0x03010000),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };

        assert_eq!(p1.landblock_chebyshev_distance_to(&p2), Some(2));
    }

    #[test]
    fn test_landblock_chebyshev_distance_to_returns_none_for_null_landblock() {
        let p1 = WorldPosition {
            landblock_id: Guid::NULL,
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let p2 = WorldPosition {
            landblock_id: Guid(0x01010000),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };

        assert_eq!(p1.landblock_chebyshev_distance_to(&p2), None);
    }

    #[test]
    fn test_normalize_outdoor_cell_recomputes_low_word_from_local_coords() {
        let pos = WorldPosition {
            landblock_id: Guid(0x3419_0039),
            coords: Vector3::new(0.3076172, 58.299316, 13.145146),
            rotation: Quaternion::identity(),
        };

        assert_eq!(pos.derived_outdoor_cell_id(), Some(0x0003));
        assert_eq!(pos.normalize_outdoor_cell().landblock_id, Guid(0x3419_0003));
    }

    #[test]
    fn test_normalize_outdoor_cell_leaves_indoor_positions_unchanged() {
        let pos = WorldPosition {
            landblock_id: Guid(0x016C_0155),
            coords: Vector3::new(12.0, -60.0, 0.0),
            rotation: Quaternion::identity(),
        };

        assert_eq!(pos.normalize_outdoor_cell(), pos);
    }

    #[test]
    fn test_distance_indoor_uses_global_space() {
        let indoor = WorldPosition {
            landblock_id: Guid(0x01000100),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let outdoor = WorldPosition {
            landblock_id: Guid(0u32),
            coords: Vector3::zero(),
            rotation: Quaternion::identity(),
        };
        let d = indoor.distance_to(&outdoor);
        assert!((d - 192.0).abs() < 1e-6, "Distance was {}", d);
    }

    #[test]
    fn test_heading_uses_global_space_across_landblocks() {
        let player = WorldPosition {
            landblock_id: Guid(0u32),
            coords: Vector3::new(10.0, 10.0, 0.0),
            rotation: Quaternion::identity(),
        };
        let target = WorldPosition {
            landblock_id: Guid(1u32 << 24),
            coords: Vector3::new(10.0, 10.0, 0.0),
            rotation: Quaternion::identity(),
        };

        let heading = player.heading_to(&target);
        assert!(
            (heading - std::f32::consts::PI).abs() < 1e-6,
            "Heading was {}",
            heading
        );
    }
}
