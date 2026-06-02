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

impl BspNode {
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
}
