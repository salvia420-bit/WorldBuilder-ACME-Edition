using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Reflection;

namespace WorldBuilder.Shared.Lib {

    /// <summary>
    /// Builds <see cref="PhysicsBSPTree"/> and <see cref="DrawingBSPTree"/> from a <see cref="GfxObj"/>'s
    /// polygon/vertex data so that the AC client can use the object for collision and rendering.
    ///
    /// Algorithm
    /// ---------
    /// Standard polygon-plane BSP construction (no polygon splitting — spanning polygons go to
    /// whichever half-space their centroid falls into):
    ///   1. Choose the best splitting plane from the polygon set (score = |front - back|).
    ///   2. Classify each polygon as FRONT, BACK, or COPLANAR by vertex-majority vote.
    ///   3. Recurse on front and back sets; create leaf nodes when depth / size limit reached.
    ///
    /// Physics BSP
    /// -----------
    ///   Inner nodes: Type = BPIN, SplittingPlane, BoundingSphere — no polygon list.
    ///   Leaf nodes:  Type = Leaf, LeafIndex, Solid, BoundingSphere, Polygons.
    ///   The negative half-space of every splitting plane is considered solid; positive is open.
    ///   PhysicsPolygons mirror the visual Polygons (same geometry, same key space).
    ///
    /// Drawing BSP
    /// -----------
    ///   Inner nodes: Type = BPIN, SplittingPlane, BoundingSphere, Polygons (coplanar at this node).
    ///   Leaf nodes:  Type = Leaf, LeafIndex only — no geometry at leaves.
    /// </summary>
    public static class BspGenerator {

        const float PlaneEpsilon = 0.0002f;
        const int MaxDepth = 24;

        // ──────────────────────────────────────────────────────────────────────
        // Public API
        // ──────────────────────────────────────────────────────────────────────

        /// <summary>
        /// Generates physics and drawing BSP trees for <paramref name="gfxObj"/>, populates
        /// <see cref="GfxObj.PhysicsPolygons"/>, <see cref="GfxObj.PhysicsBSP"/>,
        /// <see cref="GfxObj.DrawingBSP"/>, and updates <see cref="GfxObj.Flags"/>.
        /// </summary>
        public static void Build(GfxObj gfxObj) {
            if (gfxObj.Polygons is not { Count: > 0 } polys
                || gfxObj.VertexArray?.Vertices is not { } verts)
                return;

            // Compute a face plane for every polygon we can
            var planes = new Dictionary<ushort, Plane>();
            foreach (var (key, poly) in polys)
                if (TryComputePolyPlane(poly, verts, out var p))
                    planes[key] = p;

            if (planes.Count == 0) return;

            var keys = planes.Keys.ToList();

            // PhysicsPolygons mirror the visual ones
            gfxObj.PhysicsPolygons = new Dictionary<ushort, Polygon>(polys);

            int leafIdx = 0;
            gfxObj.PhysicsBSP  = new PhysicsBSPTree  { Root = BuildPhysics(keys, planes, polys, verts, ref leafIdx, 0) };
            leafIdx = 0;
            gfxObj.DrawingBSP  = new DrawingBSPTree  { Root = BuildDrawing(keys, planes, polys, verts, ref leafIdx, 0) };
            gfxObj.Flags |= GfxObjFlags.HasPhysics | GfxObjFlags.HasDrawing;
        }

        // ──────────────────────────────────────────────────────────────────────
        // Physics BSP
        // ──────────────────────────────────────────────────────────────────────

        static PhysicsBSPNode BuildPhysics(
            List<ushort> keys,
            Dictionary<ushort, Plane> planes,
            Dictionary<ushort, Polygon> polys,
            Dictionary<ushort, SWVertex> verts,
            ref int leafIdx,
            int depth) {

            if (keys.Count == 0 || depth >= MaxDepth)
                return PhysicsLeaf(keys, polys, verts, leafIdx++, solid: false);

            int si = ChooseSplitter(keys, planes, polys, verts);
            if (si < 0)
                return PhysicsLeaf(keys, polys, verts, leafIdx++, solid: false);

            Plane splitPlane = planes[keys[si]];

            var front = new List<ushort>();
            var back  = new List<ushort>();
            foreach (var k in keys) {
                switch (Classify(k, polys[k], splitPlane, verts)) {
                    case Side.Front:    front.Add(k); break;
                    default:            back.Add(k);  break; // coplanar → solid side
                }
            }

            // Guard: if all polygons land on the same side we have a degenerate split → leaf
            if (front.Count == 0 || back.Count == 0)
                return PhysicsLeaf(keys, polys, verts, leafIdx++, solid: false);

            return new PhysicsBSPNode {
                Type           = BSPNodeType.BPIN,
                SplittingPlane = splitPlane,
                LeafIndex      = -1,
                BoundingSphere = BoundingSphere(keys, polys, verts),
                Polygons       = new List<ushort>(),
                PosNode        = BuildPhysics(front, planes, polys, verts, ref leafIdx, depth + 1),
                NegNode        = BuildPhysics(back,  planes, polys, verts, ref leafIdx, depth + 1),
            };
        }

        static PhysicsBSPNode PhysicsLeaf(
            List<ushort> keys,
            Dictionary<ushort, Polygon> polys,
            Dictionary<ushort, SWVertex> verts,
            int idx,
            bool solid) {
            var node = new PhysicsBSPNode {
                Type           = BSPNodeType.Leaf,
                SplittingPlane = default,
                LeafIndex      = idx,
                BoundingSphere = BoundingSphere(keys, polys, verts),
                Polygons       = new List<ushort>(keys),
            };
            SetSolid(node, solid ? 1 : 0);
            return node;
        }

        // ──────────────────────────────────────────────────────────────────────
        // Drawing BSP
        // ──────────────────────────────────────────────────────────────────────

        static DrawingBSPNode BuildDrawing(
            List<ushort> keys,
            Dictionary<ushort, Plane> planes,
            Dictionary<ushort, Polygon> polys,
            Dictionary<ushort, SWVertex> verts,
            ref int leafIdx,
            int depth) {

            if (keys.Count == 0 || depth >= MaxDepth)
                return DrawingLeaf(leafIdx++);

            int si = ChooseSplitter(keys, planes, polys, verts);
            if (si < 0)
                return DrawingLeaf(leafIdx++);

            Plane splitPlane = planes[keys[si]];

            var front    = new List<ushort>();
            var back     = new List<ushort>();
            var coplanar = new List<ushort>();
            foreach (var k in keys) {
                switch (Classify(k, polys[k], splitPlane, verts)) {
                    case Side.Front:    front.Add(k);    break;
                    case Side.Coplanar: coplanar.Add(k); break;
                    default:            back.Add(k);     break;
                }
            }

            if (front.Count == 0 || back.Count == 0)
                return DrawingLeaf(leafIdx++);

            return new DrawingBSPNode {
                Type           = BSPNodeType.BPIN,
                SplittingPlane = splitPlane,
                LeafIndex      = -1,
                BoundingSphere = BoundingSphere(keys, polys, verts),
                Polygons       = coplanar,
                Portals        = new List<PortalRef>(),
                PosNode        = BuildDrawing(front, planes, polys, verts, ref leafIdx, depth + 1),
                NegNode        = BuildDrawing(back,  planes, polys, verts, ref leafIdx, depth + 1),
            };
        }

        static DrawingBSPNode DrawingLeaf(int idx) => new DrawingBSPNode {
            Type           = BSPNodeType.Leaf,
            SplittingPlane = default,
            LeafIndex      = idx,
            BoundingSphere = new Sphere { Origin = Vector3.Zero, Radius = 0.01f },
            Polygons       = new List<ushort>(),
            Portals        = new List<PortalRef>(),
        };

        // ──────────────────────────────────────────────────────────────────────
        // Splitter selection — minimise |front − back| over a candidate sample
        // ──────────────────────────────────────────────────────────────────────

        enum Side { Front, Back, Coplanar }

        static int ChooseSplitter(
            List<ushort> keys,
            Dictionary<ushort, Plane> planes,
            Dictionary<ushort, Polygon> polys,
            Dictionary<ushort, SWVertex> verts) {

            int best = int.MaxValue;
            int bestIdx = -1;
            int step = Math.Max(1, keys.Count / 16);

            for (int i = 0; i < keys.Count; i += step) {
                var splitPlane = planes[keys[i]];
                int f = 0, b = 0;
                foreach (var k in keys) {
                    switch (Classify(k, polys[k], splitPlane, verts)) {
                        case Side.Front: f++; break;
                        case Side.Back:  b++; break;
                    }
                }
                int score = Math.Abs(f - b);
                if (score < best && f > 0 && b > 0) { best = score; bestIdx = i; }
            }
            return bestIdx;
        }

        // Classifies polygon `poly` relative to `splitPlane` by vertex majority.
        static Side Classify(ushort key, Polygon poly, Plane splitPlane, Dictionary<ushort, SWVertex> verts) {
            int f = 0, b = 0;
            foreach (var rawId in poly.VertexIds) {
                if (rawId < 0) continue;
                if (!verts.TryGetValue((ushort)rawId, out var v)) continue;
                float d = Vector3.Dot(splitPlane.Normal, v.Origin) + splitPlane.D;
                if (d > PlaneEpsilon) f++;
                else if (d < -PlaneEpsilon) b++;
            }
            if (f > 0 && b == 0) return Side.Front;
            if (b > 0 && f == 0) return Side.Back;
            if (f == 0 && b == 0) return Side.Coplanar;
            // Spanning polygon: assign to whichever side has more vertices
            return f >= b ? Side.Front : Side.Back;
        }

        // ──────────────────────────────────────────────────────────────────────
        // Geometry helpers
        // ──────────────────────────────────────────────────────────────────────

        static bool TryComputePolyPlane(Polygon poly, Dictionary<ushort, SWVertex> verts, out Plane plane) {
            plane = default;
            Vector3? v0 = null, v1 = null, v2 = null;
            foreach (var raw in poly.VertexIds) {
                if (raw < 0) continue;
                if (!verts.TryGetValue((ushort)raw, out var sv)) continue;
                if (v0 == null)      { v0 = sv.Origin; continue; }
                else if (v1 == null) { v1 = sv.Origin; continue; }
                else                 { v2 = sv.Origin; break; }
            }
            if (v0 == null || v1 == null || v2 == null) return false;
            var n = Vector3.Cross(v1.Value - v0.Value, v2.Value - v0.Value);
            if (n.LengthSquared() < 1e-12f) return false;
            n = Vector3.Normalize(n);
            plane = new Plane(n, -Vector3.Dot(n, v0.Value));
            return true;
        }

        static Sphere BoundingSphere(
            List<ushort> keys,
            Dictionary<ushort, Polygon> polys,
            Dictionary<ushort, SWVertex> verts) {

            if (keys.Count == 0)
                return new Sphere { Origin = Vector3.Zero, Radius = 0.01f };

            var min = new Vector3(float.MaxValue);
            var max = new Vector3(float.MinValue);
            bool any = false;

            foreach (var k in keys) {
                if (!polys.TryGetValue(k, out var poly)) continue;
                foreach (var raw in poly.VertexIds) {
                    if (raw < 0) continue;
                    if (!verts.TryGetValue((ushort)raw, out var v)) continue;
                    min = Vector3.Min(min, v.Origin);
                    max = Vector3.Max(max, v.Origin);
                    any = true;
                }
            }

            if (!any) return new Sphere { Origin = Vector3.Zero, Radius = 0.01f };
            var center = (min + max) * 0.5f;
            float r = 0f;
            foreach (var k in keys) {
                if (!polys.TryGetValue(k, out var poly)) continue;
                foreach (var raw in poly.VertexIds) {
                    if (raw < 0) continue;
                    if (!verts.TryGetValue((ushort)raw, out var v)) continue;
                    r = MathF.Max(r, Vector3.Distance(center, v.Origin));
                }
            }
            return new Sphere { Origin = center, Radius = MathF.Max(r, 0.01f) };
        }

        // ──────────────────────────────────────────────────────────────────────
        // Solid flag — property is read-only; set backing field via reflection
        // ──────────────────────────────────────────────────────────────────────

        static readonly FieldInfo? _solidField =
            typeof(PhysicsBSPNode).GetField("_solid",               BindingFlags.NonPublic | BindingFlags.Instance)
            ?? typeof(PhysicsBSPNode).GetField("solid",             BindingFlags.NonPublic | BindingFlags.Instance)
            ?? typeof(PhysicsBSPNode).GetField("<Solid>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance);

        static void SetSolid(PhysicsBSPNode node, int value) =>
            _solidField?.SetValue(node, value);
    }
}
