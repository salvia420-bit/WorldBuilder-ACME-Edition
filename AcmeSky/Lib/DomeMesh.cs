using System;
using System.Runtime.InteropServices;

namespace AcmeSky.Lib {
    /// <summary>Fixed-function vertex: position + one 2D texcoord. FVF = XYZ|TEX1, stride 20.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct VertexPT {
        public float X, Y, Z;
        public float U, V;
    }

    /// <summary>Fixed-function vertex: position + diffuse ARGB. FVF = XYZ|DIFFUSE, stride 16.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct VertexPC {
        public float X, Y, Z;
        public uint Color;
    }

    /// <summary>Fixed-function vertex: position + diffuse ARGB + one 2D texcoord.
    /// FVF = XYZ|DIFFUSE|TEX1, stride 24. D3D9 requires that exact member order.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct VertexPCT {
        public float X, Y, Z;
        public uint Color;
        public float U, V;
    }

    /// <summary>
    /// A generated sky dome as an expanded triangle list, ready for DrawPrimitiveUP.
    ///
    /// Coordinate frame is AC world space: +Z is up, +X east, +Y north (the same frame the client's
    /// WorldToView matrix expects). A vertex at unit elevation <c>el</c> and azimuth <c>az</c> sits at
    ///   (cos el cos az, cos el sin az, sin el).
    /// The dome is generated on a unit sphere; the renderer scales it by a per-layer radius and
    /// translates it to the camera position, so radius only sets parallax/scroll feel -- occlusion
    /// is handled by draw order + depth state, not by the dome's physical distance.
    ///
    /// UV is equirectangular: u = az / 2pi (wraps), v = 0.5 - el/pi (v=0 at zenith, v=1 at nadir).
    /// That matches the equirect star plate directly and is a reasonable first-pass mapping for the
    /// cloud plates (whose proper azimuthal dome-UV remap is a documented downstream step).
    ///
    /// Two parallel outputs are produced from ONE tessellation:
    ///   * <see cref="Textured"/> -- VertexPT for cloud/star domes (positions + UV, immutable).
    ///   * <see cref="Elevation"/> -- per-vertex elevation, so the atmosphere pass can recolour a
    ///     VertexPC buffer every frame (horizon->zenith gradient) without re-tessellating.
    /// </summary>
    public sealed class DomeMesh {
        public readonly VertexPT[] Textured;
        public readonly float[] Elevation;   // radians, parallel to Textured
        public int TriangleCount => Textured.Length / 3;

        private DomeMesh(VertexPT[] textured, float[] elevation) {
            Textured = textured;
            Elevation = elevation;
        }

        /// <summary>
        /// CLOUD-PLANE (a.k.a. sky-plane) projection of this dome, as XYZ|DIFFUSE|TEX1 vertices with
        /// a placeholder white colour the renderer rewrites per frame.
        ///
        /// WHY NOT THE EQUIRECT UV. <see cref="Textured"/> carries the equirect mapping
        /// (u = az/2pi, v = 0.5 - el/pi), which is right for the star plate and WRONG for a cloud
        /// deck: it wraps the whole 360 degrees of azimuth into one texture width and collapses it
        /// to a point at the zenith, so a 512px plate becomes a handful of continent-sized wedges
        /// smeared radially out of the top of the sky -- exactly the "enormous amorphous blobs"
        /// the plugin was drawing. Retail (and every flight sim since) instead projects the view
        /// ray onto a horizontal PLANE at a fixed altitude: for a unit direction d the plane hit is
        /// <c>t = 1 / max(d.z, sin(minEl))</c> and <c>uv = d.xy * t * scale</c>. That gives a tiled
        /// deck straight overhead which converges and compresses toward the horizon -- the classic
        /// cloud-layer perspective -- and makes UV scroll a real horizontal wind drift.
        /// </summary>
        /// <param name="uvScale">Tile size: uv units per unit of plane distance. Smaller = larger,
        /// slower-looking clouds. ~0.28 puts roughly one tile across the overhead sky.</param>
        /// <param name="horizonCapDeg">Elevation at which the projection stops diverging. Below it
        /// the deck is pinned (and the renderer fades it out), which is what keeps the horizon from
        /// smearing into infinite-frequency aliasing.</param>
        public VertexPCT[] BuildCloudPlane(float uvScale = 0.28f, float horizonCapDeg = 5f) {
            float zMin = MathF.Sin(Math.Max(0.5f, horizonCapDeg) * MathF.PI / 180f);
            var outv = new VertexPCT[Textured.Length];
            for (int i = 0; i < Textured.Length; i++) {
                var p = Textured[i];
                float t = 1f / MathF.Max(p.Z, zMin);
                outv[i] = new VertexPCT {
                    X = p.X, Y = p.Y, Z = p.Z,
                    Color = 0xFFFFFFFF,
                    U = p.X * t * uvScale,
                    V = p.Y * t * uvScale,
                };
            }
            return outv;
        }

        /// <summary>
        /// Build a dome. <paramref name="minElevationDeg"/> is the lowest ring (e.g. -15 to dip a
        /// little below the horizon for clouds, or -90 for a full sphere used by the atmosphere).
        /// </summary>
        public static DomeMesh Build(int slices = 48, int stacks = 24,
                                     float minElevationDeg = -15f, float maxElevationDeg = 90f) {
            slices = Math.Max(6, slices);
            stacks = Math.Max(3, stacks);
            float minEl = minElevationDeg * MathF.PI / 180f;
            float maxEl = maxElevationDeg * MathF.PI / 180f;

            int quads = slices * stacks;
            int vcount = quads * 6;
            var v = new VertexPT[vcount];
            var el = new float[vcount];
            int k = 0;

            for (int s = 0; s < stacks; s++) {
                float e0 = Lerp(minEl, maxEl, (float)s / stacks);
                float e1 = Lerp(minEl, maxEl, (float)(s + 1) / stacks);
                for (int a = 0; a < slices; a++) {
                    float a0 = (float)a / slices * MathF.Tau;
                    float a1 = (float)(a + 1) / slices * MathF.Tau;

                    VertexPT p00 = Pt(e0, a0), p01 = Pt(e0, a1);
                    VertexPT p10 = Pt(e1, a0), p11 = Pt(e1, a1);

                    // Two triangles per quad (winding irrelevant: dome is drawn cull-none).
                    v[k] = p00; el[k++] = e0;
                    v[k] = p10; el[k++] = e1;
                    v[k] = p11; el[k++] = e1;

                    v[k] = p00; el[k++] = e0;
                    v[k] = p11; el[k++] = e1;
                    v[k] = p01; el[k++] = e0;
                }
            }
            return new DomeMesh(v, el);
        }

        private static VertexPT Pt(float el, float az) {
            float ce = MathF.Cos(el);
            return new VertexPT {
                X = ce * MathF.Cos(az),
                Y = ce * MathF.Sin(az),
                Z = MathF.Sin(el),
                U = az / MathF.Tau,
                V = 0.5f - el / MathF.PI,
            };
        }

        private static float Lerp(float a, float b, float t) => a + (b - a) * t;
    }
}
