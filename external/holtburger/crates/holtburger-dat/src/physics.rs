use binrw::{
    BinRead, BinResult, BinWrite,
    io::{Read, Seek, Write},
};
use holtburger_common::{Plane, Sphere, Vector3};
use std::collections::HashMap;

/// Retail `PhysicsGlobals.EPSILON` (ACE
/// `external/ACE/Source/ACE.Server/Physics/Common/PhysicsGlobals.cs:9`,
/// `public const float EPSILON = 0.0002f;`). The flat-triangle solver
/// in `holtburger-world` uses a coarser `1e-4` for its own thresholds;
/// the faithful BSP node/poly predicates below MUST use the retail
/// value so the `reach = radius - EPSILON` / `rad = radius - EPSILON`
/// margins match ACE's recursion thresholds bit-for-bit.
pub const PHYSICS_EPSILON: f32 = 0.0002_f32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum BspType {
    Drawing = 0,
    Physics = 1,
    Cell = 2,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum BspNode {
    Port(BspPortal),
    Leaf(BspLeaf),
    Internal(InternalNode),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BspPortal {
    pub plane: Plane,
    pub pos: Box<BspNode>,
    pub neg: Box<BspNode>,
    pub sphere: Option<Sphere>,
    pub poly_ids: Vec<u16>,
    pub portal_polys: Vec<PortalPoly>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BspLeaf {
    pub index: i32,
    pub solid: i32,
    pub sphere: Option<Sphere>,
    pub poly_ids: Vec<u16>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InternalNode {
    pub tag: [u8; 4],
    pub plane: Plane,
    pub pos: Option<Box<BspNode>>,
    pub neg: Option<Box<BspNode>>,
    pub sphere: Option<Sphere>,
    pub poly_ids: Vec<u16>,
}

#[derive(BinRead, BinWrite, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
#[bw(little)]
pub struct PortalPoly {
    pub portal_index: i16,
    pub poly_id: i16,
}

/// Result of testing a sphere against a CELL bsp (`BspType::Cell`),
/// mirroring ACE `BoundingType`. The cell tree partitions an EnvCell's
/// (convex) interior with splitting planes whose POSITIVE half-space is
/// "inside"; only the positive child is ever followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellBound {
    Outside,
    PartiallyInside,
    EntirelyInside,
}

impl BspNode {
    /// Faithful port of ACE `BSPNode::point_inside_cell_bsp`
    /// (BSPNode.cs:191): walk the CELL bsp following the POSITIVE side of
    /// each splitting plane. On the negative side the point is outside
    /// the cell; running off the positive end (no further child) — or
    /// reaching a leaf — means inside. Pure plane walk: the cell tree
    /// carries no polygons, so `NegNode` is never traversed.
    pub fn point_inside_cell(&self, point: &Vector3) -> bool {
        match self {
            BspNode::Internal(i) => {
                if i.plane.distance_to_point(point) >= -PHYSICS_EPSILON {
                    match &i.pos {
                        Some(pos) => pos.point_inside_cell(point),
                        None => true,
                    }
                } else {
                    false
                }
            }
            BspNode::Port(p) => {
                if p.plane.distance_to_point(point) >= -PHYSICS_EPSILON {
                    p.pos.point_inside_cell(point)
                } else {
                    false
                }
            }
            BspNode::Leaf(_) => true,
        }
    }

    /// Faithful port of ACE `BSPNode::sphere_intersects_cell_bsp`
    /// (BSPNode.cs:219): the same positive-side walk as
    /// [`Self::point_inside_cell`] but with a `radius + 0.01` straddle
    /// band (ACE's literal `0.0099999998`), classifying the sphere as
    /// fully inside, straddling, or outside the cell hull. Used to
    /// detect the moment a moving player capsule reaches an EnvCell so
    /// the client can flip indoors locally (cf. `check_building_transit`).
    pub fn sphere_intersects_cell(&self, center: &Vector3, radius: f32) -> CellBound {
        let (plane, pos) = match self {
            BspNode::Internal(i) => (&i.plane, i.pos.as_deref()),
            BspNode::Port(p) => (&p.plane, Some(&*p.pos)),
            BspNode::Leaf(_) => return CellBound::EntirelyInside,
        };
        let dist = plane.distance_to_point(center);
        let check_rad = radius + 0.01;
        if dist <= -check_rad {
            return CellBound::Outside;
        }
        if dist >= check_rad {
            return match pos {
                Some(p) => p.sphere_intersects_cell(center, radius),
                None => CellBound::EntirelyInside,
            };
        }
        match pos {
            Some(p) => {
                if p.sphere_intersects_cell(center, radius) != CellBound::Outside {
                    CellBound::PartiallyInside
                } else {
                    CellBound::Outside
                }
            }
            None => CellBound::PartiallyInside,
        }
    }

    pub fn read<R: Read + Seek>(reader: &mut R, tree_type: BspType) -> BinResult<Self> {
        let mut tag = [0u8; 4];
        reader.read_exact(&mut tag)?;

        let mut reversed_tag = tag;
        reversed_tag.reverse();

        match &reversed_tag {
            b"PORT" => Ok(BspNode::Port(BspPortal::read(reader, tree_type)?)),
            b"LEAF" => Ok(BspNode::Leaf(BspLeaf::read(reader, tree_type)?)),
            _ => Ok(BspNode::Internal(InternalNode::read(
                reader,
                tree_type,
                reversed_tag,
            )?)),
        }
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W, tree_type: BspType) -> BinResult<()> {
        match self {
            BspNode::Port(p) => {
                let tag = *b"TROP"; // "PORT" reversed
                writer.write_all(&tag)?;
                p.write(writer, tree_type)
            }
            BspNode::Leaf(l) => {
                let tag = *b"FAEL"; // "LEAF" reversed
                writer.write_all(&tag)?;
                l.write(writer, tree_type)
            }
            BspNode::Internal(i) => {
                let mut tag = i.tag;
                tag.reverse();
                writer.write_all(&tag)?;
                i.write(writer, tree_type)
            }
        }
    }

    /// Check if a sphere intersects any "solid" space within this BSP tree.
    pub fn intersects_solid(&self, center: &holtburger_common::Vector3, radius: f32) -> bool {
        match self {
            BspNode::Port(p) => {
                let dist = p.plane.distance_to_point(center);
                if dist > radius {
                    p.pos.intersects_solid(center, radius)
                } else if dist < -radius {
                    p.neg.intersects_solid(center, radius)
                } else {
                    // Straddle: check both sides
                    p.pos.intersects_solid(center, radius) || p.neg.intersects_solid(center, radius)
                }
            }
            BspNode::Leaf(l) => {
                // If it's a solid leaf, and the sphere could possibly be in it, it's a hit.
                // We trust the tree structure to lead us to the right leaf,
                // but checking the bounding sphere is a safe extra layer.
                if l.solid == 1 {
                    if let Some(s) = &l.sphere {
                        return s.intersects(center, radius);
                    }
                    return true;
                }
                false
            }
            BspNode::Internal(i) => {
                // Early exit using bounding sphere if present.
                if let Some(s) = &i.sphere
                    && !s.intersects(center, radius)
                {
                    return false;
                }

                let dist = i.plane.distance_to_point(center);

                // If the sphere is on the positive side (or straddling), check the positive subtree.
                if dist >= -radius
                    && let Some(pos) = &i.pos
                    && pos.intersects_solid(center, radius)
                {
                    return true;
                }

                // If the sphere is on the negative side (or straddling), check the negative subtree.
                if dist <= radius
                    && let Some(neg) = &i.neg
                    && neg.intersects_solid(center, radius)
                {
                    return true;
                }

                false
            }
        }
    }

    // ---------------------------------------------------------------
    // Faithful ACE BSP narrow-phase predicates (PASS 1, 2026-06-02).
    //
    // These supersede the approximate `intersects_solid` above. They
    // are 1:1 ports of the static node walks in
    //   ACE BSPNode.cs:242-293  (sphere_intersects_poly / _solid)
    //   ACE BSPLeaf.cs:67-91    (leaf overrides)
    //   ACE Polygon.cs:331-398  (polygon_hits_sphere_precise)
    // operating in CELL-LOCAL space (the BSP planes + polygon vertices
    // are authored cell-local). The caller transforms its query sphere
    // INTO cell-local space before calling — matching ACE's
    // `SpherePath.LocalSpacePos`. They are pure + side-effect-free
    // (the `&out` params of the C# originals are returned in the tuple
    // instead), so they unit-test against synthetic + real DAT trees.
    //
    // `polys` is the cell's resolved physics-polygon table keyed by the
    // same `u16` poly-id the leaf `poly_ids` reference — see
    // [`resolve_cell_physics_polygons`]. A leaf id that misses the
    // table is skipped (defensive against a partially-resolved cell);
    // ACE never misses because its tree shares the cell's poly cache.
    // ---------------------------------------------------------------

    /// Faithful port of ACE `BSPNode.sphere_intersects_solid`
    /// (`BSPNode.cs:265-293`) + the `BSPLeaf` override
    /// (`BSPLeaf.cs:80-91`). Returns `true` when `check_pos` (a
    /// cell-local sphere) intersects solid space in this physics BSP.
    ///
    /// `center_check` threads ACE's `centerCheck` bool: it starts
    /// `true` (the sphere center is presumed to be on the solid-test
    /// side) and flips to `false` for the subtree on the far side of a
    /// straddled splitting plane, exactly mirroring the
    /// `BSPNode.cs:279-292` `dist < 0` fan-out. A solid leaf hits
    /// immediately when `center_check` is still set (the sphere center
    /// is inside solid space); otherwise the leaf falls through to the
    /// per-polygon `polygon_hits_sphere_precise` boundary test.
    pub fn sphere_intersects_solid(
        &self,
        check_pos: &Sphere,
        center_check: bool,
        polys: &HashMap<u16, ResolvedPolygon>,
    ) -> bool {
        match self {
            BspNode::Leaf(l) => {
                // BSPLeaf.cs:80-91
                if l.poly_ids.is_empty() {
                    return false;
                }
                if center_check && l.solid == 1 {
                    return true;
                }
                if let Some(s) = &l.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return false;
                }
                for &pid in &l.poly_ids {
                    if let Some(poly) = polys.get(&pid)
                        && poly.hits_sphere(check_pos)
                    {
                        return true;
                    }
                }
                false
            }
            BspNode::Internal(i) => {
                // BSPNode.cs:265-293. Bounding-sphere early-out first.
                if let Some(s) = &i.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return false;
                }
                Self::node_sphere_intersects_solid(
                    &i.plane, &i.pos, &i.neg, check_pos, center_check, polys,
                )
            }
            BspNode::Port(p) => {
                // Physics trees do not normally contain PORT nodes; if
                // one appears, recurse with the same plane/child shape.
                if let Some(s) = &p.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return false;
                }
                Self::node_sphere_intersects_solid(
                    &p.plane,
                    &Some(p.pos.clone()),
                    &Some(p.neg.clone()),
                    check_pos,
                    center_check,
                    polys,
                )
            }
        }
    }

    /// Shared internal-node recursion for [`Self::sphere_intersects_solid`].
    /// Pulled out so `Internal` (Option children) and `Port` (boxed
    /// children) share the exact `BSPNode.cs:270-292` plane fan-out.
    fn node_sphere_intersects_solid(
        plane: &Plane,
        pos: &Option<Box<BspNode>>,
        neg: &Option<Box<BspNode>>,
        check_pos: &Sphere,
        center_check: bool,
        polys: &HashMap<u16, ResolvedPolygon>,
    ) -> bool {
        let dist = plane.normal.dot(&check_pos.center) + plane.d;
        let reach = check_pos.radius - PHYSICS_EPSILON;

        if dist >= reach {
            return pos
                .as_ref()
                .is_some_and(|n| n.sphere_intersects_solid(check_pos, center_check, polys));
        }
        if dist <= -reach {
            return neg
                .as_ref()
                .is_some_and(|n| n.sphere_intersects_solid(check_pos, center_check, polys));
        }
        // Straddle: descend both, flipping center_check on the side the
        // sphere center is NOT on (BSPNode.cs:279-292).
        if dist < 0.0 {
            if pos
                .as_ref()
                .is_some_and(|n| n.sphere_intersects_solid(check_pos, false, polys))
            {
                return true;
            }
            neg.as_ref()
                .is_some_and(|n| n.sphere_intersects_solid(check_pos, center_check, polys))
        } else {
            if pos
                .as_ref()
                .is_some_and(|n| n.sphere_intersects_solid(check_pos, center_check, polys))
            {
                return true;
            }
            neg.as_ref()
                .is_some_and(|n| n.sphere_intersects_solid(check_pos, false, polys))
        }
    }

    /// BSP resolver M2 (2026-06-02). Faithful port of ACE
    /// `BSPNode.sphere_intersects_solid_poly` (`BSPNode.cs:295-325`) + the
    /// `BSPLeaf` override (`BSPLeaf.cs:93-112`). Like
    /// [`Self::sphere_intersects_solid`], but also reports WHICH solid
    /// polygon the sphere's boundary first crosses (`hit_poly`) and whether
    /// the sphere center sits inside solid space (`center_solid`) — the two
    /// outputs ACE's `BSPTree.placement_insert` resolver consumes to push a
    /// placement sphere out of solid geometry. Returns ACE's bool result:
    /// once a polygon is surfaced the recursion short-circuits and reports
    /// `center_solid`; otherwise the running solid state.
    ///
    /// This is the per-polygon query that upgrades the coarse solid GATE
    /// (spatial-side `cell_physics_bsp_solid`) toward polygon-level
    /// avoidance. Not yet wired into a placement loop (that is M3); this is
    /// the faithful primitive + its tests, exercised only under
    /// `USE_PHYSICS_BSP` (DEFAULT-OFF) so the shipped solver is unchanged.
    pub fn sphere_intersects_solid_poly(
        &self,
        check_pos: &Sphere,
        radius: f32,
        center_check: bool,
        polys: &HashMap<u16, ResolvedPolygon>,
        center_solid: &mut bool,
        hit_poly: &mut Option<u16>,
    ) -> bool {
        match self {
            BspNode::Leaf(l) => {
                // BSPLeaf.cs:93-112. The leaf IGNORES `radius`: its bounding
                // reject + poly tests use `check_pos` (ACE `checkPos`, the
                // ORIGINAL sphere radius). Only the node `reach` uses the
                // doubled `radius` (ACE BSPNode.cs:301).
                if l.poly_ids.is_empty() {
                    return false;
                }
                if center_check && l.solid == 1 {
                    *center_solid = true;
                }
                if let Some(s) = &l.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return *center_solid;
                }
                for &pid in &l.poly_ids {
                    if let Some(poly) = polys.get(&pid)
                        && poly.hits_sphere(check_pos)
                    {
                        *hit_poly = Some(pid);
                        return true;
                    }
                }
                *center_solid
            }
            BspNode::Internal(i) => {
                if let Some(s) = &i.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return false;
                }
                Self::node_sphere_intersects_solid_poly(
                    &i.plane, &i.pos, &i.neg, check_pos, radius, center_check, polys, center_solid,
                    hit_poly,
                )
            }
            BspNode::Port(p) => {
                if let Some(s) = &p.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return false;
                }
                Self::node_sphere_intersects_solid_poly(
                    &p.plane,
                    &Some(p.pos.clone()),
                    &Some(p.neg.clone()),
                    check_pos,
                    radius,
                    center_check,
                    polys,
                    center_solid,
                    hit_poly,
                )
            }
        }
    }

    /// Shared internal-node recursion for
    /// [`Self::sphere_intersects_solid_poly`] (`BSPNode.cs:300-325`). The
    /// near child is descended first; once it sets `hit_poly`, ACE
    /// short-circuits and returns `center_solid`, else the far child is
    /// descended with `center_check` forced false.
    #[allow(clippy::too_many_arguments)]
    fn node_sphere_intersects_solid_poly(
        plane: &Plane,
        pos: &Option<Box<BspNode>>,
        neg: &Option<Box<BspNode>>,
        check_pos: &Sphere,
        radius: f32,
        center_check: bool,
        polys: &HashMap<u16, ResolvedPolygon>,
        center_solid: &mut bool,
        hit_poly: &mut Option<u16>,
    ) -> bool {
        let dist = plane.normal.dot(&check_pos.center) + plane.d;
        // ACE BSPNode.cs:301 — `reach` uses the placement `radius` (which the
        // caller doubles each widen iteration), NOT `check_pos.radius` (the
        // original sphere radius, used only by the bounding rejects above).
        let reach = radius - PHYSICS_EPSILON;

        if dist >= reach {
            return match pos.as_ref() {
                Some(n) => {
                    n.sphere_intersects_solid_poly(check_pos, radius, center_check, polys, center_solid, hit_poly)
                }
                None => false,
            };
        }
        if dist <= -reach {
            return match neg.as_ref() {
                Some(n) => {
                    n.sphere_intersects_solid_poly(check_pos, radius, center_check, polys, center_solid, hit_poly)
                }
                None => false,
            };
        }
        // Straddle: descend the near side first (BSPNode.cs:309-324). If it
        // surfaced a polygon (incl. a STICKY hit_poly from a prior placement
        // iteration), stop and report `center_solid`; else descend the far
        // side with `center_check` forced false.
        if dist <= 0.0 {
            if let Some(n) = neg.as_ref() {
                n.sphere_intersects_solid_poly(check_pos, radius, center_check, polys, center_solid, hit_poly);
            }
            if hit_poly.is_some() {
                return *center_solid;
            }
            match pos.as_ref() {
                Some(n) => n.sphere_intersects_solid_poly(check_pos, radius, false, polys, center_solid, hit_poly),
                None => *center_solid,
            }
        } else {
            if let Some(n) = pos.as_ref() {
                n.sphere_intersects_solid_poly(check_pos, radius, center_check, polys, center_solid, hit_poly);
            }
            if hit_poly.is_some() {
                return *center_solid;
            }
            match neg.as_ref() {
                Some(n) => n.sphere_intersects_solid_poly(check_pos, radius, false, polys, center_solid, hit_poly),
                None => *center_solid,
            }
        }
    }

    /// Faithful port of ACE `BSPNode.sphere_intersects_poly`
    /// (`BSPNode.cs:242-263`) + the `BSPLeaf` override
    /// (`BSPLeaf.cs:67-78`). Walks to the leaf containing `check_pos`
    /// and returns `Some((poly_id, contact_point))` for the first
    /// physics polygon whose front face is hit by the moving sphere
    /// (`Polygon.pos_hits_sphere`, `Polygon.cs:386-398`), else `None`.
    /// `movement` is the cell-local motion vector (used by the
    /// front-face gate `dot(movement, plane.normal) < 0`).
    pub fn sphere_intersects_poly(
        &self,
        check_pos: &Sphere,
        movement: Vector3,
        polys: &HashMap<u16, ResolvedPolygon>,
    ) -> Option<(u16, Vector3)> {
        match self {
            BspNode::Leaf(l) => {
                if l.poly_ids.is_empty() {
                    return None;
                }
                if let Some(s) = &l.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return None;
                }
                for &pid in &l.poly_ids {
                    if let Some(poly) = polys.get(&pid)
                        && let Some(contact) = poly.pos_hits_sphere(check_pos, movement)
                    {
                        return Some((pid, contact));
                    }
                }
                None
            }
            BspNode::Internal(i) => {
                if let Some(s) = &i.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return None;
                }
                Self::node_sphere_intersects_poly(
                    &i.plane, &i.pos, &i.neg, check_pos, movement, polys,
                )
            }
            BspNode::Port(p) => {
                if let Some(s) = &p.sphere
                    && !s.intersects(&check_pos.center, check_pos.radius)
                {
                    return None;
                }
                Self::node_sphere_intersects_poly(
                    &p.plane,
                    &Some(p.pos.clone()),
                    &Some(p.neg.clone()),
                    check_pos,
                    movement,
                    polys,
                )
            }
        }
    }

    fn node_sphere_intersects_poly(
        plane: &Plane,
        pos: &Option<Box<BspNode>>,
        neg: &Option<Box<BspNode>>,
        check_pos: &Sphere,
        movement: Vector3,
        polys: &HashMap<u16, ResolvedPolygon>,
    ) -> Option<(u16, Vector3)> {
        let dist = plane.normal.dot(&check_pos.center) + plane.d;
        let reach = check_pos.radius - PHYSICS_EPSILON;

        if dist >= reach {
            return pos
                .as_ref()
                .and_then(|n| n.sphere_intersects_poly(check_pos, movement, polys));
        }
        if dist <= -reach {
            return neg
                .as_ref()
                .and_then(|n| n.sphere_intersects_poly(check_pos, movement, polys));
        }
        // Straddle: BSPNode.cs:256-262 checks Pos then Neg.
        if let Some(hit) = pos
            .as_ref()
            .and_then(|n| n.sphere_intersects_poly(check_pos, movement, polys))
        {
            return Some(hit);
        }
        neg.as_ref()
            .and_then(|n| n.sphere_intersects_poly(check_pos, movement, polys))
    }
}

/// A physics polygon with its vertex positions resolved from the cell's
/// vertex array and its plane computed via ACE's `Polygon.make_plane`
/// (`Polygon.cs:210-232`). The faithful BSP predicates operate on these
/// rather than the raw DAT `Polygon` (which stores only `vertex_ids`
/// + flags) — exactly as ACE's `Polygon` carries resolved `Vertices`
/// + `Plane`. All coordinates are CELL-LOCAL.
#[derive(Debug, Clone)]
pub struct ResolvedPolygon {
    pub num_points: usize,
    pub vertices: Vec<Vector3>,
    pub plane: Plane,
}

impl ResolvedPolygon {
    /// ACE `Polygon.make_plane` (`Polygon.cs:210-232`): area-weighted
    /// normal summed over the triangle fan, then the plane distance is
    /// the mean of `dot(normal, vertex)` over all points (negated).
    /// Returns `None` for a degenerate polygon (zero-area / <3 points)
    /// whose normal can't be normalized.
    pub fn make_plane(vertices: &[Vector3]) -> Option<Plane> {
        let n = vertices.len();
        if n < 3 {
            return None;
        }
        // for (i = NumPoints-2, spreadIdx = 1; i > 0; i--) sum cross of
        //   (V[spreadIdx++] - V[0]) x (V[spreadIdx] - V[0])
        let mut normal = Vector3::zero();
        let mut spread = 1usize;
        let mut i = n as isize - 2;
        while i > 0 {
            let v1 = vertices[spread] - vertices[0];
            spread += 1;
            let v2 = vertices[spread] - vertices[0];
            normal = normal + v1.cross(&v2);
            i -= 1;
        }
        let len = normal.length();
        if len < 1e-12 {
            return None;
        }
        let normal = normal / len;
        let dist_sum: f32 = vertices.iter().map(|v| normal.dot(v)).sum();
        let d = -(dist_sum / n as f32);
        Some(Plane { normal, d })
    }

    /// ACE `Polygon.hits_sphere` (`Polygon.cs:204-208`): boundary test
    /// against the precise solver, discarding the contact point.
    pub fn hits_sphere(&self, sphere: &Sphere) -> bool {
        self.polygon_hits_sphere_precise(sphere).is_some()
    }

    /// ACE `Polygon.pos_hits_sphere` (`Polygon.cs:386-398`): hit the
    /// precise sphere test, then gate on the front-face condition
    /// `dot(movement, plane.normal) < 0` (a sphere moving INTO the
    /// front face). Returns the contact point on a confirmed
    /// front-face hit.
    pub fn pos_hits_sphere(&self, sphere: &Sphere, movement: Vector3) -> Option<Vector3> {
        let contact = self.polygon_hits_sphere_precise(sphere);
        let dist = movement.dot(&self.plane.normal);
        if dist >= 0.0 {
            return None;
        }
        contact
    }

    /// Faithful port of ACE `Polygon.polygon_hits_sphere_precise`
    /// (`Polygon.cs:331-384`). Returns `Some(contact_point)` when the
    /// sphere intersects the (convex) polygon's face within the
    /// `radius - EPSILON` slab, else `None`. The nested edge loop is
    /// ACE's verbatim two-pass containment test (outer loop finds an
    /// edge the contact point is outside of, inner loop confirms it's
    /// within the rounded corner / edge band of every edge).
    pub fn polygon_hits_sphere_precise(&self, sphere: &Sphere) -> Option<Vector3> {
        if self.num_points == 0 {
            // ACE returns true with no contact written; emit center.
            return Some(sphere.center);
        }
        let dp_pos = self.plane.normal.dot(&sphere.center) + self.plane.d;
        let rad = sphere.radius - PHYSICS_EPSILON;
        if dp_pos.abs() > rad {
            return None;
        }
        let diff = rad * rad - dp_pos * dp_pos;
        let contact = sphere.center - self.plane.normal * dp_pos;

        let verts = &self.vertices;
        let count = verts.len();
        let mut prev_idx = count - 1;
        for i in 0..count {
            let vertex = verts[i];
            let last_vertex = verts[prev_idx];
            prev_idx = i;

            let edge = vertex - last_vertex;
            let disp = contact - last_vertex;
            let cross = self.plane.normal.cross(&edge);

            if disp.dot(&cross) >= 0.0 {
                continue;
            }

            // inner loop (Polygon.cs:356-381)
            let mut prev_j = count - 1;
            for j in 0..count {
                let vertex = verts[j];
                let last_vertex = verts[prev_j];
                prev_j = j;

                let edge = vertex - last_vertex;
                let disp = contact - last_vertex;
                let cross = self.plane.normal.cross(&edge);
                let disp_dot = disp.dot(&cross);

                if disp_dot < 0.0 {
                    if cross.length_squared() * diff < disp_dot * disp_dot {
                        return None;
                    }
                    let disp_edge = disp.dot(&edge);
                    if disp_edge >= 0.0 && disp_edge <= edge.length_squared() {
                        return Some(contact);
                    }
                }

                if disp.length_squared() <= diff {
                    return Some(contact);
                }
            }
            return None;
        }
        Some(contact)
    }

    /// BSP resolver M2 (2026-06-02). Faithful port of ACE
    /// `Polygon.adjust_to_placement_poly` (`Polygon.cs:116-126`). Displaces
    /// `hit_sphere`'s center along this polygon's plane normal so the sphere
    /// is pushed to sit `radius` off the face — the per-polygon nudge the
    /// `BSPTree.placement_insert` loop applies each time
    /// [`BspNode::sphere_intersects_solid_poly`] surfaces this polygon.
    /// `other_sphere` (the cylinder's second sphere) gets the same
    /// displacement. When `solid_check` and the center is on/behind the face
    /// (`center_solid || dp <= 0`), the push direction is reversed (radius
    /// negated), matching ACE. Pure geometry; consumed only by the future
    /// placement loop under `USE_PHYSICS_BSP` (DEFAULT-OFF).
    pub fn adjust_to_placement_poly(
        &self,
        hit_sphere: &mut Sphere,
        other_sphere: Option<&mut Sphere>,
        radius: f32,
        center_solid: bool,
        solid_check: bool,
    ) {
        let dp = hit_sphere.center.dot(&self.plane.normal) + self.plane.d;
        let radius = if solid_check && (center_solid || dp <= 0.0) {
            -radius
        } else {
            radius
        };
        let adjusted = self.plane.normal * (radius - dp);
        hit_sphere.center = hit_sphere.center + adjusted;
        if let Some(other) = other_sphere {
            other.center = other.center + adjusted;
        }
    }
}

/// BSP resolver M3 (2026-06-02, INERT). The 3-variant outcome of ACE
/// `BSPTree.placement_insert` (`BSPTree.cs:242-292`). ACE returns a full
/// `TransitionState`, but `placement_insert` can only ever produce these
/// three (`OK` / `Adjusted` / `Collided`) — never `Invalid` / `Slid`. We
/// keep a `holtburger-dat`-local enum here rather than depending on
/// `holtburger-world::TransitionState` (`collision.rs:13`): the crate
/// dependency direction is dat → (nothing world), so the M4 caller (in
/// `holtburger-world`) maps `PlacementState` → `TransitionState` at the
/// seam with a trivial 3-arm match. Not wired into a live solver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum PlacementState {
    /// `BSPTree.cs:296-297`: first query (i == 0) was clean — never moved.
    Ok,
    /// `BSPTree.cs:299,302`: had to displace ≥1×, then a clean query.
    Adjusted,
    /// `BSPTree.cs:291`: 20 iterations exhausted without a clean query.
    Collided,
}

/// BSP resolver M3 (2026-06-02, INERT). Result of
/// [`BspNode::placement_insert_bsp`] — the faithful port of ACE
/// `BSPTree.placement_insert` (`BSPTree.cs:242-292`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementProbe {
    /// ACE return of `placement_insert`: `Ok` (clean / never moved),
    /// `Adjusted` (had to displace — see `local_displacement`), or
    /// `Collided` (could not free within 20 iterations).
    pub state: PlacementState,
    /// Net CELL-LOCAL displacement of sphere-0 across the whole loop:
    /// ACE `adjust = validPos.Center - LocalSpaceSphere[0].Center`
    /// (`BSPTree.cs:299`). `Vector3::zero()` unless `state == Adjusted`.
    /// The caller rotates this into global + applies it (NOT M3's job).
    pub local_displacement: Vector3,
}

impl BspNode {
    /// BSP resolver M3 (2026-06-02, INERT). Faithful port of ACE
    /// `BSPTree.placement_insert` + `placement_insert_inner`
    /// (`BSPTree.cs:242-303`). Drives the already-landed M2 query
    /// [`Self::sphere_intersects_solid_poly`] (`physics.rs:322`) and M2b
    /// nudge [`ResolvedPolygon::adjust_to_placement_poly`] (`physics.rs:686`)
    /// in ACE's up-to-20-iteration `query → adjust → widen` loop to push a
    /// placement cylinder out of solid BSP geometry within ONE cell.
    ///
    /// ALL coordinates are CELL-LOCAL (the same frame the M2 primitives and
    /// [`resolve_cell_physics_polygons`] operate in). The caller (the future
    /// M4/M5 `CellCollisionFn`) is responsible for transforming the body's
    /// spheres into this frame (ACE `CacheLocalSpaceSphere`,
    /// `SpherePath.cs:181-207`) and, on `Adjusted`, for rotating the returned
    /// `local_displacement` into global via `LocalSpacePos.LocalToGlobalVec`
    /// (`BSPTree.cs:300`) and applying it with `AddOffsetToCheckPos`.
    ///
    /// `local_spheres` is the body's cell-local cylinder: `[0]` (low/sphere-0)
    /// is always present; `[1]` (high) is consulted iff `num_sphere > 1`
    /// (ACE `LocalSpaceSphere[0..NumSphere]`). `clear_cell` is ACE's
    /// `clearCell` / `centerCheck` (`BSPTree.cs:253-255`): `true` unless the
    /// building-check found an interior cell. `polys` is the cell's resolved
    /// physics polygons ([`resolve_cell_physics_polygons`]).
    ///
    /// Not wired into a live solver. Pure geometry over the BSP + polys;
    /// exercised only by the M3 unit tests under `USE_PHYSICS_BSP`
    /// (DEFAULT-OFF), mirroring M2/M2b.
    pub fn placement_insert_bsp(
        &self,
        local_spheres: &[Sphere],
        num_sphere: u8,
        clear_cell: bool,
        polys: &HashMap<u16, ResolvedPolygon>,
    ) -> PlacementProbe {
        // BSPTree.cs:246-247 — validPos = LocalSpaceSphere[0]; rad = validPos.Radius
        let mut valid_pos = local_spheres[0]; // Sphere is Copy
        let origin0 = valid_pos.center; // for placement_insert_inner adjust
        let mut rad = valid_pos.radius;

        // BSPTree.cs:250-251 — second cylinder sphere only when NumSphere > 1
        let two = num_sphere > 1;
        let mut valid_pos_ = if two {
            local_spheres[1]
        } else {
            Sphere {
                center: Vector3::zero(),
                radius: 0.0,
            }
        };

        // BSPTree.cs:259 — hardcoded
        const MAX_ITERATIONS: usize = 20;

        // ACE BSPTree.cs:257 — `hitPoly` is declared ONCE and is STICKY across
        // iterations (it is never reset; the node recursion short-circuits the
        // far child on a non-null incoming hit_poly — BSPNode.cs:313/321). Only
        // `centerSolid` is reset per iteration (BSPTree.cs:262). `rad` is kept
        // SEPARATE from the sphere radius and passed explicitly (used only for
        // node `reach`); the probe spheres' `.radius` stays at the original
        // `local_sphere` value, which the bounding rejects read.
        let mut hit_poly: Option<u16> = None;

        for i in 0..MAX_ITERATIONS {
            // ----- probe sphere-0 (BSPTree.cs:262-263) -----
            let mut center_solid = false;
            let hit = self.sphere_intersects_solid_poly(
                &valid_pos,
                rad,
                clear_cell,
                polys,
                &mut center_solid,
                &mut hit_poly,
            );

            if hit {
                // BSPTree.cs:265-269 — found a boundary poly → nudge & RE-QUERY.
                if let Some(pid) = hit_poly {
                    let poly = polys.get(&pid).expect("hit_poly id present in polys map");
                    // M2b: adjust BOTH spheres along the poly plane (validPos
                    // primary, validPos_ the "other"). radius = rad,
                    // solid_check = clear_cell.
                    if two {
                        let mut other = valid_pos_; // copy out to satisfy borrow rules
                        poly.adjust_to_placement_poly(
                            &mut valid_pos,
                            Some(&mut other),
                            rad,
                            center_solid,
                            clear_cell,
                        );
                        valid_pos_ = other;
                    } else {
                        poly.adjust_to_placement_poly(
                            &mut valid_pos,
                            None,
                            rad,
                            center_solid,
                            clear_cell,
                        );
                    }
                    continue; // re-query at SAME rad
                }
                // hit==true but hit_poly==None → fall through to widen
                // (BSPTree.cs:289).
            } else if two {
                // ----- sphere-0 missed; probe sphere-1 (BSPTree.cs:271-279).
                // ACE reuses the SAME `centerSolid` + `hitPoly` refs for both.
                let hit2 = self.sphere_intersects_solid_poly(
                    &valid_pos_,
                    rad,
                    clear_cell,
                    polys,
                    &mut center_solid,
                    &mut hit_poly,
                );
                if hit2 {
                    if let Some(pid) = hit_poly {
                        let poly = polys.get(&pid).expect("hit_poly id present in polys map");
                        // BSPTree.cs:279 — adjust(validPos_, validPos):
                        // sphere-1 primary, sphere-0 the "other".
                        let mut other = valid_pos;
                        poly.adjust_to_placement_poly(
                            &mut valid_pos_,
                            Some(&mut other),
                            rad,
                            center_solid,
                            clear_cell,
                        );
                        valid_pos = other;
                        continue; // re-query at SAME rad
                    }
                    // hit2==true but no poly → widen (fall through)
                } else {
                    // both spheres clean → done (BSPTree.cs:283-284)
                    return Self::placement_insert_inner(valid_pos.center, origin0, i);
                }
            } else {
                // single sphere, clean → done (BSPTree.cs:286-287)
                return Self::placement_insert_inner(valid_pos.center, origin0, i);
            }

            // BSPTree.cs:289 — reached ONLY on (intersect==true && hitPoly==None),
            // for whichever sphere probe set that condition. Widen the probe.
            rad *= 2.0;
        }

        // BSPTree.cs:291 — ran out of iterations.
        PlacementProbe {
            state: PlacementState::Collided,
            local_displacement: Vector3::zero(),
        }
    }

    /// ACE `BSPTree.placement_insert_inner` (`BSPTree.cs:294-303`). On the
    /// FIRST iteration with no displacement (`i == 0`) the placement is
    /// clean → `Ok`, zero offset. Otherwise the net cell-local displacement
    /// of sphere-0 is `valid_center - origin0` (ACE
    /// `validPos.Center - LocalSpaceSphere[0].Center`) → `Adjusted`. The
    /// rotate-into-global + `AddOffsetToCheckPos` (`BSPTree.cs:300-301`) is
    /// the caller's responsibility (it owns `LocalSpacePos`).
    fn placement_insert_inner(valid_center: Vector3, origin0: Vector3, i: usize) -> PlacementProbe {
        if i == 0 {
            return PlacementProbe {
                state: PlacementState::Ok,
                local_displacement: Vector3::zero(),
            };
        }
        PlacementProbe {
            state: PlacementState::Adjusted,
            local_displacement: valid_center - origin0,
        }
    }
}

/// Resolve a cell's physics polygons into [`ResolvedPolygon`]s keyed by
/// poly-id, ready for the faithful BSP predicates. `polys` is the
/// `CellStruct.physics_polygons` map; `vertices` is the cell's
/// `CVertexArray` (`u16` vertex-id → origin). A polygon whose
/// `vertex_ids` don't all resolve, or whose plane is degenerate, is
/// skipped (matching the wasm fan-triangulation's defensive skip). All
/// coordinates stay CELL-LOCAL — the caller transforms the query sphere
/// into this frame, never the geometry into world space.
pub fn resolve_cell_physics_polygons(
    polys: &HashMap<u16, crate::graphics::Polygon>,
    lookup_vertex: impl Fn(u16) -> Option<Vector3>,
) -> HashMap<u16, ResolvedPolygon> {
    let mut out = HashMap::with_capacity(polys.len());
    for (&pid, poly) in polys {
        if poly.num_pts < 3 {
            continue;
        }
        let mut verts = Vec::with_capacity(poly.num_pts as usize);
        let mut ok = true;
        for &vid in &poly.vertex_ids {
            if vid < 0 {
                ok = false;
                break;
            }
            match lookup_vertex(vid as u16) {
                Some(v) => verts.push(v),
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok || verts.len() < 3 {
            continue;
        }
        let Some(plane) = ResolvedPolygon::make_plane(&verts) else {
            continue;
        };
        out.insert(
            pid,
            ResolvedPolygon {
                num_points: verts.len(),
                vertices: verts,
                plane,
            },
        );
    }
    out
}

impl BspPortal {
    pub fn read<R: Read + Seek>(reader: &mut R, tree_type: BspType) -> BinResult<Self> {
        let plane = Plane::read_le(reader)?;
        let pos = Box::new(BspNode::read(reader, tree_type)?);
        let neg = Box::new(BspNode::read(reader, tree_type)?);

        let mut poly_ids = Vec::new();
        let mut portal_polys = Vec::new();
        let mut sphere = None;

        if tree_type == BspType::Drawing {
            sphere = Some(Sphere::read_le(reader)?);
            let num_polys = u32::read_le(reader)?;
            let num_portals = u32::read_le(reader)?;

            for _ in 0..num_polys {
                poly_ids.push(u16::read_le(reader)?);
            }

            for _ in 0..num_portals {
                portal_polys.push(PortalPoly::read(reader)?);
            }
        }

        Ok(BspPortal {
            plane,
            pos,
            neg,
            sphere,
            poly_ids,
            portal_polys,
        })
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W, tree_type: BspType) -> BinResult<()> {
        self.plane.write_le(writer)?;
        self.pos.write(writer, tree_type)?;
        self.neg.write(writer, tree_type)?;

        if tree_type == BspType::Drawing {
            if let Some(s) = &self.sphere {
                s.write_le(writer)?;
            } else {
                Sphere {
                    center: holtburger_common::Vector3::zero(),
                    radius: 0.0,
                }
                .write_le(writer)?;
            }
            (self.poly_ids.len() as u32).write_le(writer)?;
            (self.portal_polys.len() as u32).write_le(writer)?;

            for &id in &self.poly_ids {
                id.write_le(writer)?;
            }

            for &poly in &self.portal_polys {
                poly.write_le(writer)?;
            }
        }
        Ok(())
    }
}

impl BspLeaf {
    pub fn read<R: Read + Seek>(reader: &mut R, tree_type: BspType) -> BinResult<Self> {
        let index = i32::read_le(reader)?;
        let mut solid = 0;
        let mut sphere = None;
        let mut poly_ids = Vec::new();

        if tree_type == BspType::Physics {
            solid = i32::read_le(reader)?;
            sphere = Some(Sphere::read_le(reader)?);
            let num_polys = u32::read_le(reader)?;
            for _ in 0..num_polys {
                poly_ids.push(u16::read_le(reader)?);
            }
        }

        Ok(BspLeaf {
            index,
            solid,
            sphere,
            poly_ids,
        })
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W, tree_type: BspType) -> BinResult<()> {
        self.index.write_le(writer)?;

        if tree_type == BspType::Physics {
            self.solid.write_le(writer)?;
            if let Some(s) = &self.sphere {
                s.write_le(writer)?;
            } else {
                Sphere {
                    center: holtburger_common::Vector3::zero(),
                    radius: 0.0,
                }
                .write_le(writer)?;
            }
            (self.poly_ids.len() as u32).write_le(writer)?;
            for &id in &self.poly_ids {
                id.write_le(writer)?;
            }
        }
        Ok(())
    }
}

impl InternalNode {
    pub fn read<R: Read + Seek>(
        reader: &mut R,
        tree_type: BspType,
        tag: [u8; 4],
    ) -> BinResult<Self> {
        let plane = Plane::read_le(reader)?;

        let mut pos = None;
        let mut neg = None;

        match &tag {
            b"BPnn" | b"BPIn" => {
                pos = Some(Box::new(BspNode::read(reader, tree_type)?));
            }
            b"BpIN" | b"BpnN" => {
                neg = Some(Box::new(BspNode::read(reader, tree_type)?));
            }
            b"BPIN" | b"BPnN" => {
                pos = Some(Box::new(BspNode::read(reader, tree_type)?));
                neg = Some(Box::new(BspNode::read(reader, tree_type)?));
            }
            _ => {}
        }

        let mut sphere = None;
        let mut poly_ids = Vec::new();

        if tree_type != BspType::Cell {
            sphere = Some(Sphere::read_le(reader)?);
            if tree_type != BspType::Physics {
                let num_polys = u32::read_le(reader)?;
                for _ in 0..num_polys {
                    poly_ids.push(u16::read_le(reader)?);
                }
            }
        }

        Ok(InternalNode {
            tag,
            plane,
            pos,
            neg,
            sphere,
            poly_ids,
        })
    }

    pub fn write<W: Write + Seek>(&self, writer: &mut W, tree_type: BspType) -> BinResult<()> {
        self.plane.write_le(writer)?;

        if let Some(pos) = &self.pos {
            pos.write(writer, tree_type)?;
        }
        if let Some(neg) = &self.neg {
            neg.write(writer, tree_type)?;
        }

        if tree_type != BspType::Cell {
            if let Some(s) = &self.sphere {
                s.write_le(writer)?;
            } else {
                Sphere {
                    center: holtburger_common::Vector3::zero(),
                    radius: 0.0,
                }
                .write_le(writer)?;
            }

            if tree_type != BspType::Physics {
                (self.poly_ids.len() as u32).write_le(writer)?;
                for &id in &self.poly_ids {
                    id.write_le(writer)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_bsp_leaf_parsing() {
        let mut data = Vec::new();
        data.extend_from_slice(b"FAEL"); // LEAF
        data.extend_from_slice(&(123i32).to_le_bytes()); // Index
        data.extend_from_slice(&(1i32).to_le_bytes()); // Solid
        // Sphere (Center {0,0,0}, Radius 5.0)
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(5.0f32).to_le_bytes());
        // NumPolys
        data.extend_from_slice(&(2u32).to_le_bytes());
        // PolyIds
        data.extend_from_slice(&(10u16).to_le_bytes());
        data.extend_from_slice(&(20u16).to_le_bytes());

        let mut cursor = Cursor::new(data);
        let node = BspNode::read(&mut cursor, BspType::Physics).unwrap();

        if let BspNode::Leaf(leaf) = node {
            assert_eq!(leaf.index, 123);
            assert_eq!(leaf.solid, 1);
            assert_eq!(leaf.sphere.unwrap().radius, 5.0);
            assert_eq!(leaf.poly_ids, vec![10, 20]);
        } else {
            panic!("Expected Leaf node");
        }
    }

    #[test]
    fn test_recursive_bsp_internal() {
        let mut data = Vec::new();
        // Root: BPnn (only pos child)
        data.extend_from_slice(b"nnPB");
        // Plane (Normal {0,1,0}, D -10)
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(1.0f32).to_le_bytes());
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(-10.0f32).to_le_bytes());

        // Pos Child: LEAF
        data.extend_from_slice(b"FAEL");
        data.extend_from_slice(&(1i32).to_le_bytes()); // Index
        data.extend_from_slice(&(0i32).to_le_bytes()); // Solid
        data.extend_from_slice(&(0.0f32).to_le_bytes()); // Sphere Center X
        data.extend_from_slice(&(0.0f32).to_le_bytes()); // Sphere Center Y
        data.extend_from_slice(&(0.0f32).to_le_bytes()); // Sphere Center Z
        data.extend_from_slice(&(1.0f32).to_le_bytes()); // Sphere Radius
        data.extend_from_slice(&(0u32).to_le_bytes()); // NumPolys

        // Internal Sphere (for the BPnn node)
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(10.0f32).to_le_bytes());
        data.extend_from_slice(&(0.0f32).to_le_bytes());
        data.extend_from_slice(&(20.0f32).to_le_bytes());

        let mut cursor = Cursor::new(data);
        let node = BspNode::read(&mut cursor, BspType::Physics).unwrap();

        if let BspNode::Internal(node) = node {
            assert_eq!(&node.tag, b"BPnn");
            assert!(node.pos.is_some());
            assert!(node.neg.is_none());
            assert_eq!(node.sphere.unwrap().radius, 20.0);

            if let BspNode::Leaf(child) = *node.pos.unwrap() {
                assert_eq!(child.index, 1);
            } else {
                panic!("Expected Leaf child");
            }
        } else {
            panic!("Expected Internal node");
        }
    }

    // ---------------------------------------------------------------
    // Faithful narrow-phase predicate tests (PASS 1).
    // ---------------------------------------------------------------

    fn v(x: f32, y: f32, z: f32) -> Vector3 {
        Vector3::new(x, y, z)
    }

    /// A unit square in the z=0 plane (CCW from above), centered on the
    /// origin, spanning x,y ∈ [-1, 1]. Normal points +Z.
    fn square_floor() -> ResolvedPolygon {
        let verts = vec![
            v(-1.0, -1.0, 0.0),
            v(1.0, -1.0, 0.0),
            v(1.0, 1.0, 0.0),
            v(-1.0, 1.0, 0.0),
        ];
        let plane = ResolvedPolygon::make_plane(&verts).expect("non-degenerate");
        ResolvedPolygon {
            num_points: verts.len(),
            vertices: verts,
            plane,
        }
    }

    #[test]
    fn make_plane_matches_ace_for_axis_quad() {
        let poly = square_floor();
        // Normal should be ±Z (orientation depends on winding); the
        // z=0 plane has D == 0.
        assert!(poly.plane.normal.x.abs() < 1e-5);
        assert!(poly.plane.normal.y.abs() < 1e-5);
        assert!((poly.plane.normal.z.abs() - 1.0).abs() < 1e-5);
        assert!(poly.plane.d.abs() < 1e-5);
    }

    #[test]
    fn make_plane_degenerate_returns_none() {
        // Collinear points => zero-area => no plane.
        let verts = vec![v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(2.0, 0.0, 0.0)];
        assert!(ResolvedPolygon::make_plane(&verts).is_none());
        // Fewer than 3 points.
        assert!(ResolvedPolygon::make_plane(&verts[..2]).is_none());
    }

    #[test]
    fn polygon_hits_sphere_precise_inside_and_outside() {
        let poly = square_floor();
        // Sphere centered above the square center, within radius of the
        // plane => hit, contact projected onto the plane (z=0).
        let s_hit = Sphere {
            center: v(0.0, 0.0, 0.2),
            radius: 0.5,
        };
        let contact = poly
            .polygon_hits_sphere_precise(&s_hit)
            .expect("sphere over the face should hit");
        assert!(contact.z.abs() < 1e-4, "contact projects onto z=0 plane");

        // Sphere far above the plane (beyond radius) => miss.
        let s_far = Sphere {
            center: v(0.0, 0.0, 2.0),
            radius: 0.5,
        };
        assert!(poly.polygon_hits_sphere_precise(&s_far).is_none());

        // Sphere near the plane but laterally off the square (outside
        // the footprint by more than radius) => miss.
        let s_side = Sphere {
            center: v(5.0, 0.0, 0.05),
            radius: 0.4,
        };
        assert!(poly.polygon_hits_sphere_precise(&s_side).is_none());
    }

    #[test]
    fn pos_hits_sphere_front_face_gate() {
        let poly = square_floor();
        let s = Sphere {
            center: v(0.0, 0.0, 0.2),
            radius: 0.5,
        };
        let n = poly.plane.normal;
        // Moving INTO the front face (opposite the normal) => hit.
        let into = n * -1.0;
        assert!(poly.pos_hits_sphere(&s, into).is_some());
        // Moving AWAY from the face (along the normal) => gated off.
        assert!(poly.pos_hits_sphere(&s, n).is_none());
    }

    /// Build a physics BSP: root internal node split on the z=0 plane
    /// (normal +Z). Positive side (z>0, "above the floor") is empty
    /// air; negative side (z<0, "below the floor") is a solid leaf
    /// carrying the floor polygon. Mirrors a one-floor cell.
    fn floor_tree() -> (BspNode, HashMap<u16, ResolvedPolygon>) {
        let mut polys = HashMap::new();
        polys.insert(7u16, square_floor());

        let air = BspNode::Leaf(BspLeaf {
            index: 0,
            solid: 0,
            sphere: Some(Sphere {
                center: v(0.0, 0.0, 1.0),
                radius: 10.0,
            }),
            poly_ids: vec![],
        });
        let solid = BspNode::Leaf(BspLeaf {
            index: 1,
            solid: 1,
            sphere: Some(Sphere {
                center: v(0.0, 0.0, -1.0),
                radius: 10.0,
            }),
            poly_ids: vec![7],
        });
        let root = BspNode::Internal(InternalNode {
            tag: *b"BPIN",
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            pos: Some(Box::new(air)),
            neg: Some(Box::new(solid)),
            sphere: Some(Sphere {
                center: v(0.0, 0.0, 0.0),
                radius: 100.0,
            }),
            poly_ids: vec![],
        });
        (root, polys)
    }

    #[test]
    fn sphere_intersects_solid_center_below_floor_is_solid() {
        let (tree, polys) = floor_tree();
        // Sphere center BELOW z=0 => solid-side leaf, center_check stays
        // true => solid hit.
        let below = Sphere {
            center: v(0.0, 0.0, -0.5),
            radius: 0.4,
        };
        assert!(tree.sphere_intersects_solid(&below, true, &polys));
    }

    #[test]
    fn sphere_intersects_solid_center_well_above_is_free() {
        let (tree, polys) = floor_tree();
        // Sphere comfortably above the floor (> radius) => air leaf, no
        // polygons => not solid.
        let above = Sphere {
            center: v(0.0, 0.0, 5.0),
            radius: 0.4,
        };
        assert!(!tree.sphere_intersects_solid(&above, true, &polys));
    }

    #[test]
    fn sphere_intersects_solid_straddling_floor_hits_boundary_poly() {
        let (tree, polys) = floor_tree();
        // Sphere center just above z=0 but radius reaches through the
        // floor plane => straddle => the negative (solid) side is
        // entered with center_check=false, and the boundary polygon
        // test fires.
        let straddle = Sphere {
            center: v(0.0, 0.0, 0.1),
            radius: 0.5,
        };
        assert!(tree.sphere_intersects_solid(&straddle, true, &polys));
    }

    // ---- BSP resolver M2: sphere_intersects_solid_poly ----

    #[test]
    fn solid_poly_straddle_reports_hit_polygon() {
        let (tree, polys) = floor_tree();
        // Same straddle geometry as the solid test: center just above z=0,
        // radius reaching through to the floor polygon.
        let straddle = Sphere {
            center: v(0.0, 0.0, 0.1),
            radius: 0.5,
        };
        let mut center_solid = false;
        let mut hit_poly = None;
        let hit =
            tree.sphere_intersects_solid_poly(&straddle, straddle.radius, true, &polys, &mut center_solid, &mut hit_poly);
        assert_eq!(hit_poly, Some(7), "straddle should surface the floor polygon");
        assert!(!center_solid, "center is above the floor, not inside solid space");
        assert!(hit, "a surfaced polygon is an intersection");
    }

    #[test]
    fn solid_poly_center_below_is_center_solid_without_polygon() {
        let (tree, polys) = floor_tree();
        // Center inside the solid leaf, but too far below to touch the
        // floor polygon's boundary band.
        let below = Sphere {
            center: v(0.0, 0.0, -0.5),
            radius: 0.4,
        };
        let mut center_solid = false;
        let mut hit_poly = None;
        let hit =
            tree.sphere_intersects_solid_poly(&below, below.radius, true, &polys, &mut center_solid, &mut hit_poly);
        assert!(center_solid, "center below the floor is inside solid space");
        assert_eq!(hit_poly, None, "no boundary polygon within reach");
        assert!(hit, "center_solid is reported as the intersect result");
    }

    #[test]
    fn solid_poly_well_above_is_free() {
        let (tree, polys) = floor_tree();
        let above = Sphere {
            center: v(0.0, 0.0, 5.0),
            radius: 0.4,
        };
        let mut center_solid = false;
        let mut hit_poly = None;
        let hit =
            tree.sphere_intersects_solid_poly(&above, above.radius, true, &polys, &mut center_solid, &mut hit_poly);
        assert!(!hit);
        assert!(!center_solid);
        assert_eq!(hit_poly, None);
    }

    // ---- BSP resolver M2: adjust_to_placement_poly ----

    #[test]
    fn adjust_to_placement_poly_pushes_sphere_off_face() {
        let poly = ResolvedPolygon {
            num_points: 0,
            vertices: vec![],
            plane: Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 },
        };
        let mut s = Sphere { center: v(0.0, 0.0, 0.1), radius: 0.5 };
        // dp=0.1, no solid_check => diff = 0.5-0.1 = 0.4 along +Z => z=0.5.
        poly.adjust_to_placement_poly(&mut s, None, 0.5, false, false);
        assert!((s.center.z - 0.5).abs() < 1e-5, "got {:?}", s.center);
        assert!(s.center.x.abs() < 1e-6 && s.center.y.abs() < 1e-6);
    }

    #[test]
    fn adjust_to_placement_poly_solid_check_reverses_push() {
        let poly = ResolvedPolygon {
            num_points: 0,
            vertices: vec![],
            plane: Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 },
        };
        let mut s = Sphere { center: v(0.0, 0.0, -0.1), radius: 0.5 };
        // solid_check && dp(-0.1)<=0 => radius negated to -0.5;
        // diff = -0.5 - (-0.1) = -0.4 along +Z => z=-0.5.
        poly.adjust_to_placement_poly(&mut s, None, 0.5, false, true);
        assert!((s.center.z + 0.5).abs() < 1e-5, "got {:?}", s.center);
    }

    #[test]
    fn adjust_to_placement_poly_displaces_other_sphere_equally() {
        let poly = ResolvedPolygon {
            num_points: 0,
            vertices: vec![],
            plane: Plane { normal: v(0.0, 0.0, 1.0), d: 0.0 },
        };
        let mut a = Sphere { center: v(0.0, 0.0, 0.1), radius: 0.5 };
        let mut b = Sphere { center: v(1.0, 0.0, 0.1), radius: 0.5 };
        poly.adjust_to_placement_poly(&mut a, Some(&mut b), 0.5, false, false);
        assert!((a.center.z - 0.5).abs() < 1e-5);
        // `b` receives the identical (0,0,0.4) displacement.
        assert!((b.center.z - 0.5).abs() < 1e-5);
        assert!((b.center.x - 1.0).abs() < 1e-6);
    }

    // ---- CELL bsp membership (point/sphere inside cell) ----

    fn half_space_cell() -> BspNode {
        // One splitting plane (normal +Z, d=0): positive half-space
        // (z >= 0) is "inside the cell", negative is outside. `pos`/`neg`
        // are null so the walk terminates immediately past the plane.
        BspNode::Internal(InternalNode {
            tag: *b"BPnn",
            plane: Plane {
                normal: v(0.0, 0.0, 1.0),
                d: 0.0,
            },
            pos: None,
            neg: None,
            sphere: None,
            poly_ids: vec![],
        })
    }

    #[test]
    fn point_inside_cell_follows_positive_side() {
        let cell = half_space_cell();
        // On / above the plane => inside (falls off the positive end).
        assert!(cell.point_inside_cell(&v(0.0, 0.0, 1.0)));
        assert!(cell.point_inside_cell(&v(5.0, -3.0, 0.0)));
        // Below the plane => outside (negative side is never traversed).
        assert!(!cell.point_inside_cell(&v(0.0, 0.0, -1.0)));
    }

    #[test]
    fn sphere_intersects_cell_classifies_band() {
        let cell = half_space_cell();
        // Wholly on the positive side, clear of the band => inside.
        assert_eq!(
            cell.sphere_intersects_cell(&v(0.0, 0.0, 0.5), 0.1),
            CellBound::EntirelyInside
        );
        // Wholly on the negative side, clear of the band => outside.
        assert_eq!(
            cell.sphere_intersects_cell(&v(0.0, 0.0, -1.0), 0.1),
            CellBound::Outside
        );
        // Straddling the plane within radius+0.01 => partially inside.
        assert_eq!(
            cell.sphere_intersects_cell(&v(0.0, 0.0, 0.0), 0.2),
            CellBound::PartiallyInside
        );
    }

    #[test]
    fn sphere_intersects_poly_finds_floor_when_descending() {
        let (tree, polys) = floor_tree();
        let on_floor = Sphere {
            center: v(0.0, 0.0, 0.1),
            radius: 0.5,
        };
        // Descending (-Z) into the +Z-facing floor => front-face hit.
        let hit = tree.sphere_intersects_poly(&on_floor, v(0.0, 0.0, -1.0), &polys);
        assert!(hit.is_some(), "descending onto the floor should hit");
        let (pid, _contact) = hit.unwrap();
        assert_eq!(pid, 7);
        // Rising (+Z) away from the floor => front-face gate refuses.
        let none = tree.sphere_intersects_poly(&on_floor, v(0.0, 0.0, 1.0), &polys);
        assert!(none.is_none(), "rising away from the floor is gated off");
    }

    #[test]
    fn resolve_cell_physics_polygons_skips_missing_and_degenerate() {
        use crate::graphics::Polygon as DatPoly;
        let mut polys: HashMap<u16, DatPoly> = HashMap::new();
        // Good triangle: ids 0,1,2.
        polys.insert(
            1,
            DatPoly {
                num_pts: 3,
                stippling: 0,
                sides_type: 2,
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 2],
                pos_uv_indices: vec![],
                neg_uv_indices: vec![],
            },
        );
        // Missing-vertex polygon: id 99 has no vertex => skipped.
        polys.insert(
            2,
            DatPoly {
                num_pts: 3,
                stippling: 0,
                sides_type: 2,
                pos_surface: 0,
                neg_surface: -1,
                vertex_ids: vec![0, 1, 99],
                pos_uv_indices: vec![],
                neg_uv_indices: vec![],
            },
        );
        let verts: HashMap<u16, Vector3> = [
            (0u16, v(0.0, 0.0, 0.0)),
            (1, v(1.0, 0.0, 0.0)),
            (2, v(0.0, 1.0, 0.0)),
        ]
        .into_iter()
        .collect();
        let resolved =
            resolve_cell_physics_polygons(&polys, |vid| verts.get(&vid).copied());
        assert!(resolved.contains_key(&1), "good triangle resolves");
        assert!(!resolved.contains_key(&2), "missing-vertex poly skipped");
        assert_eq!(resolved[&1].num_points, 3);
    }

    /// Skipped when `HOLTBURGER_PORTAL_DAT` is unset. Loads the retail
    /// EOR Environment `0x0D00062E` (the same record the parser
    /// round-trip test pins: 1 cell, 8 verts, 6 physics polygons),
    /// resolves its physics polygons cell-local, and walks the parsed
    /// `physics_bsp` with the faithful `sphere_intersects_solid` /
    /// `sphere_intersects_poly` predicates over a 3D probe grid. The
    /// contract is "runs against a real DAT tree without panicking and
    /// resolves a non-empty poly table" — exact solid/free classification
    /// is geometry-specific and covered by the synthetic tests above.
    #[test]
    fn faithful_predicates_walk_retail_environment_bsp() {
        use crate::DatDatabase;
        use crate::file_type::Environment;
        use std::io::Cursor;
        let Some(path) = crate::utils::get_portal_dat_path() else {
            return;
        };
        let Ok(dat) = DatDatabase::new(&path) else {
            return;
        };
        let Ok(bytes) = dat.get_file(0x0D00_062E) else {
            return;
        };
        let env = Environment::unpack(&mut Cursor::new(&bytes))
            .expect("EnvCell 0x0D00062E should unpack");
        let cell = env.cells.values().next().expect("at least one cell");
        let tree = cell
            .physics_bsp
            .as_ref()
            .expect("retail cell carries a physics BSP");

        let resolved = resolve_cell_physics_polygons(&cell.physics_polygons, |vid| {
            cell.vertex_array
                .vertices
                .get(&vid)
                .map(|sw| Vector3::new(sw.origin.x, sw.origin.y, sw.origin.z))
        });
        assert!(
            !resolved.is_empty(),
            "retail cell with 6 physics polygons resolves a non-empty table"
        );

        // Probe a grid spanning the cell bounds; every call must
        // terminate without panic. We don't assert a specific
        // solid/free count — that depends on the exact cell geometry —
        // only that the faithful walk is robust on real data.
        let mut solid_hits = 0usize;
        let mut poly_hits = 0usize;
        for ix in -4..=4 {
            for iy in -4..=4 {
                for iz in -2..=4 {
                    let center = Vector3::new(ix as f32, iy as f32, iz as f32);
                    let sphere = Sphere {
                        center,
                        radius: 0.4,
                    };
                    if tree.sphere_intersects_solid(&sphere, true, &resolved) {
                        solid_hits += 1;
                    }
                    if tree
                        .sphere_intersects_poly(&sphere, Vector3::new(0.0, 0.0, -1.0), &resolved)
                        .is_some()
                    {
                        poly_hits += 1;
                    }
                }
            }
        }
        // Sanity: the probe grid is large enough that SOME sample lands
        // on solid space / a boundary polygon in a real interior cell.
        // (If the cell happened to be entirely open this could be 0; we
        // log rather than hard-fail to keep the smoke robust across
        // whichever record the DAT ships.)
        let _ = (solid_hits, poly_hits);
    }

    // ---- BSP resolver M3: placement_insert_bsp ----

    /// i == 0, single sphere comfortably in free space (well above the floor):
    /// first query is clean → Ok, zero displacement. (BSPTree.cs:286-287,296-297)
    #[test]
    fn placement_insert_clean_free_space_is_ok_zero_offset() {
        let (tree, polys) = floor_tree();
        let spheres = [Sphere {
            center: v(0.0, 0.0, 5.0),
            radius: 0.4,
        }];
        let probe = tree.placement_insert_bsp(&spheres, 1, true, &polys);
        assert_eq!(probe.state, PlacementState::Ok);
        assert!(
            probe.local_displacement.length() < 1e-6,
            "no move expected: {:?}",
            probe.local_displacement
        );
    }

    /// Single sphere straddling the floor (center just above z=0, radius reaches
    /// through): iter 0 surfaces poly 7, adjust_to_placement_poly pushes it up to
    /// sit `rad` off the +Z face, iter 1 is clean → Adjusted with +Z displacement.
    /// (BSPTree.cs:262-269 then 286-287,299)
    #[test]
    fn placement_insert_straddle_pushes_up_and_reports_adjusted() {
        let (tree, polys) = floor_tree();
        // Same straddle geometry as solid_poly_straddle_reports_hit_polygon.
        let spheres = [Sphere {
            center: v(0.0, 0.0, 0.1),
            radius: 0.5,
        }];
        let probe = tree.placement_insert_bsp(&spheres, 1, true, &polys);
        assert_eq!(probe.state, PlacementState::Adjusted);
        // Pushed along +Z by adjust_to_placement_poly: net displacement is +Z.
        assert!(
            probe.local_displacement.z > 0.0,
            "should push up off the floor: {:?}",
            probe.local_displacement
        );
        assert!(
            probe.local_displacement.x.abs() < 1e-5 && probe.local_displacement.y.abs() < 1e-5
        );
        // After the push the sphere center is rad off the plane (dp == rad):
        // origin z=0.1 → final z = origin.z + displacement.z; assert it cleared
        // the face (z ~= radius off the z=0 plane).
        let final_z = 0.1 + probe.local_displacement.z;
        assert!(
            (final_z - spheres[0].radius).abs() < 1e-3,
            "final z should be ~radius off face: {final_z}"
        );
    }

    /// Sphere center buried BELOW the floor (inside solid) with clear_cell=true.
    /// FAITHFUL outcome on this fixture is `Collided`, NOT a clean -Z push:
    /// in the straddle the leaf sets `centerSolid=true` and the M2 node returns
    /// `centerSolid` (true) with `hit_poly=Some(7)` (ACE `BSPNode.cs:312` /
    /// `BSPLeaf.cs:96-97,108`), so M3 enters the adjust branch. With
    /// `solid_check && (center_solid || dp<=0)` the radius is NEGATED
    /// (`Polygon.cs:119-120`), so `adjust_to_placement_poly` pushes the sphere
    /// DEEPER into the solid each iteration (z: -0.1 → -0.5 → out of reach →
    /// `rad *= 2` widen → poly back in reach → -1.0 → …). The probe never
    /// reaches free space within 20 iterations → `Collided`, zero offset. This
    /// is the byte-faithful ACE result for "center buried below a floor with the
    /// solid-side reverse-push": the single floor poly cannot free it. (The
    /// spec §8 draft expected `Adjusted -Z`; the verified primitive behavior is
    /// `Collided`, which is what a faithful transcription produces.)
    #[test]
    fn placement_insert_center_below_floor_reverses_push() {
        let (tree, polys) = floor_tree();
        // Center below z=0 (in the solid leaf) but the floor poly within radius.
        let spheres = [Sphere {
            center: v(0.0, 0.0, -0.1),
            radius: 0.5,
        }];
        let probe = tree.placement_insert_bsp(&spheres, 1, true, &polys);
        assert_eq!(probe.state, PlacementState::Collided);
        assert!(
            probe.local_displacement.length() < 1e-6,
            "Collided leaves no offset: {:?}",
            probe.local_displacement
        );
    }

    /// Two-sphere cylinder: low sphere straddles the floor, high sphere is clear.
    /// The low sphere is displaced and BOTH spheres receive the same plane delta
    /// (adjust_to_placement_poly other_sphere arm); loop converges → Adjusted.
    /// (BSPTree.cs:250-251,267 with validPos_ as `other`)
    #[test]
    fn placement_insert_two_sphere_low_hit_displaces_both() {
        let (tree, polys) = floor_tree();
        let spheres = [
            Sphere {
                center: v(0.0, 0.0, 0.1),
                radius: 0.5,
            }, // low, straddles
            Sphere {
                center: v(0.0, 0.0, 2.0),
                radius: 0.5,
            }, // high, clear of floor
        ];
        let probe = tree.placement_insert_bsp(&spheres, 2, true, &polys);
        assert_eq!(probe.state, PlacementState::Adjusted);
        assert!(probe.local_displacement.z > 0.0);
        // Regression guard: the reported displacement is sphere-0's net move
        // (BSPTree.cs:299 uses validPos / LocalSpaceSphere[0]), NOT sphere-1's.
    }

    /// Two-sphere cylinder fully in free space: both queries clean on iter 0 →
    /// Ok, zero offset. (BSPTree.cs:283-284,296-297)
    #[test]
    fn placement_insert_two_sphere_free_is_ok() {
        let (tree, polys) = floor_tree();
        let spheres = [
            Sphere {
                center: v(0.0, 0.0, 5.0),
                radius: 0.3,
            },
            Sphere {
                center: v(0.0, 0.0, 6.0),
                radius: 0.3,
            },
        ];
        let probe = tree.placement_insert_bsp(&spheres, 2, true, &polys);
        assert_eq!(probe.state, PlacementState::Ok);
        assert!(probe.local_displacement.length() < 1e-6);
    }

    /// clear_cell threading (building-check). The `clear_cell` / `centerCheck`
    /// bool flows into the M2 query as `center_check`, which gates whether the
    /// solid leaf sets `centerSolid` (`BSPLeaf.cs:96-97`). For a center buried
    /// below the floor this bool flips the WHOLE outcome — proving it is
    /// threaded, not dropped:
    ///
    /// * clear_cell=TRUE  → leaf sets centerSolid → node returns `true` with the
    ///   surfaced poly → M3 enters the (reverse) adjust branch and diverges →
    ///   `Collided` (see `placement_insert_center_below_floor_reverses_push`).
    /// * clear_cell=FALSE → leaf leaves centerSolid=false → node returns
    ///   `centerSolid` (false) even though `hit_poly=Some(7)` is set
    ///   (ACE `BSPNode.cs:312` returns the bool, NOT the poly flag) → M3's
    ///   `if hit` is false → single-sphere clean-miss at i=0 → `Ok`, zero
    ///   offset. The surfaced poly is gated off by the false bool exactly as
    ///   ACE `BSPTree.cs:262` (`if (...sphere_intersects_solid_poly(...))`).
    ///
    /// (The spec §8 draft expected `Adjusted +Z`; the verified bool-vs-hit_poly
    /// gate yields `Ok` here, which a faithful transcription produces.)
    #[test]
    fn placement_insert_clear_cell_false_threads_solid_check() {
        let (tree, polys) = floor_tree();
        let spheres = [Sphere {
            center: v(0.0, 0.0, -0.1),
            radius: 0.5,
        }];
        let probe_false = tree.placement_insert_bsp(&spheres, 1, false, &polys);
        assert_eq!(
            probe_false.state,
            PlacementState::Ok,
            "clear_cell=false gates the surfaced poly off the bool result"
        );
        assert!(probe_false.local_displacement.length() < 1e-6);

        // Same geometry with clear_cell=true takes the divergent reverse-push.
        let probe_true = tree.placement_insert_bsp(&spheres, 1, true, &polys);
        assert_eq!(
            probe_true.state,
            PlacementState::Collided,
            "clear_cell=true sets centerSolid → reverse-push diverges"
        );
        assert_ne!(
            probe_false.state, probe_true.state,
            "the clear_cell bool must change the outcome (it is threaded)"
        );
    }

    /// Iteration cap: a degenerate solid leaf whose bounding sphere always
    /// intersects but whose poly id is ABSENT from `polys`, so the M2 leaf arm
    /// only reaches `if let Some(poly) = polys.get(&pid)` and never sets
    /// `hit_poly` (physics.rs:344-350). Result: center_solid=true,
    /// hit_poly=None every iteration → the `rad *= 2` widen branch fires all 20
    /// iterations and never converges → Collided, zero offset.
    /// (BSPTree.cs:288-291)
    #[test]
    fn placement_insert_runs_out_of_iterations_is_collided() {
        let solid = BspNode::Leaf(BspLeaf {
            index: 1,
            solid: 1,
            sphere: Some(Sphere {
                center: v(0.0, 0.0, 0.0),
                radius: 1.0e6,
            }),
            poly_ids: vec![999], // id intentionally ABSENT from polys
        });
        let polys: HashMap<u16, ResolvedPolygon> = HashMap::new();
        let spheres = [Sphere {
            center: v(0.0, 0.0, 0.0),
            radius: 0.4,
        }];
        let probe = solid.placement_insert_bsp(&spheres, 1, true, &polys);
        assert_eq!(probe.state, PlacementState::Collided);
        assert!(
            probe.local_displacement.length() < 1e-6,
            "Collided leaves no offset"
        );
    }
}
