using System;
using System.Collections.Generic;
using System.Numerics;
using Silk.NET.OpenGL;
using Chorizite.Core.Render;
using WorldBuilder.Lib;

namespace WorldBuilder.Editors.Landscape {
    public enum GizmoMode { Translate, Rotate, Scale }
    public enum GizmoAxis { None, X, Y, Z, XY, XZ, YZ, All }

    public class TransformGizmo : IDisposable {
        private const float ArrowLength = 1.3f;
        private const float ShaftThickness = 0.07f;
        private const float TipLength = 0.30f;
        private const float TipRadius = 0.13f;
        private const float PlaneHandleSize = 0.35f;
        private const float PlaneHandleOffset = 0.45f;
        private const float RingRadius = 1.05f;
        private const float RingThickness = 0.055f;
        private const float CubeHalfSize = 0.11f;
        private const int ConeSides = 12;
        private const int RingSegments = 48;
        private const float HitThresholdPx = 24f;
        private const float ScreenScaleFactor = 0.15f;

        private static readonly Vector3 Red = new(1.0f, 0.22f, 0.22f);
        private static readonly Vector3 Green = new(0.22f, 0.95f, 0.22f);
        private static readonly Vector3 Blue = new(0.30f, 0.45f, 1.0f);
        private static readonly Vector3 Yellow = new(1.0f, 1.0f, 0.25f);
        private static readonly Vector3 Magenta = new(1.0f, 0.25f, 1.0f);
        private static readonly Vector3 Cyan = new(0.25f, 1.0f, 1.0f);
        private static readonly Vector3 White = new(0.95f, 0.95f, 0.95f);

        public GizmoMode Mode { get; set; } = GizmoMode.Translate;
        public GizmoAxis HoveredAxis { get; private set; } = GizmoAxis.None;
        public GizmoAxis ActiveAxis { get; private set; } = GizmoAxis.None;
        public bool IsDragging => ActiveAxis != GizmoAxis.None;
        public bool UseLocalSpace { get; set; }

        private uint _vao, _vbo, _ebo;
        private bool _initialized;
        private IShader? _shader;

        private float[] _translateVerts = Array.Empty<float>();
        private uint[] _translateIndices = Array.Empty<uint>();
        private AxisSection[] _translateSections = Array.Empty<AxisSection>();

        private float[] _rotateVerts = Array.Empty<float>();
        private uint[] _rotateIndices = Array.Empty<uint>();
        private AxisSection[] _rotateSections = Array.Empty<AxisSection>();

        private float[] _scaleVerts = Array.Empty<float>();
        private uint[] _scaleIndices = Array.Empty<uint>();
        private AxisSection[] _scaleSections = Array.Empty<AxisSection>();

        private float[] _boxVerts = Array.Empty<float>();
        private uint[] _boxIndices = Array.Empty<uint>();
        private uint _boxVAO, _boxVBO, _boxEBO;
        private bool _boxDirty = true;

        private Vector3 _dragPlaneOrigin;
        private Vector3 _dragPlaneNormal;
        private Vector3 _dragAxisDir;
        private Vector3 _dragStartHit;
        private float _dragStartAngle;

        struct AxisSection {
            public GizmoAxis Axis;
            public int IndexOffset;
            public int IndexCount;
        }

        public unsafe void Initialize(GL gl, IShader shader) {
            _shader = shader;

            BuildTranslateGeometry();
            BuildRotateGeometry();
            BuildScaleGeometry();

            gl.GenVertexArrays(1, out _vao);
            gl.GenBuffers(1, out _vbo);
            gl.GenBuffers(1, out _ebo);

            gl.BindVertexArray(_vao);
            gl.BindBuffer(GLEnum.ArrayBuffer, _vbo);
            gl.BindBuffer(GLEnum.ElementArrayBuffer, _ebo);
            SetupVertexAttribs(gl);
            gl.BindVertexArray(0);

            gl.GenVertexArrays(1, out _boxVAO);
            gl.GenBuffers(1, out _boxVBO);
            gl.GenBuffers(1, out _boxEBO);

            gl.BindVertexArray(_boxVAO);
            gl.BindBuffer(GLEnum.ArrayBuffer, _boxVBO);
            gl.BindBuffer(GLEnum.ElementArrayBuffer, _boxEBO);
            SetupVertexAttribs(gl);
            gl.BindVertexArray(0);

            _initialized = true;
        }

        private static unsafe void SetupVertexAttribs(GL gl) {
            uint stride = 6 * sizeof(float);
            gl.EnableVertexAttribArray(0);
            gl.VertexAttribPointer(0, 3, GLEnum.Float, false, stride, (void*)0);
            gl.EnableVertexAttribArray(1);
            gl.VertexAttribPointer(1, 3, GLEnum.Float, false, stride, (void*)(3 * sizeof(float)));
        }

        public unsafe void Render(GL gl, Matrix4x4 viewProjection, ICamera camera,
            Vector3 gizmoCenter, Quaternion gizmoOrientation, bool hasSelection) {
            if (!_initialized || _shader == null || !hasSelection) return;

            float gizmoScale = ComputeScale(camera, gizmoCenter);
            var orientMatrix = UseLocalSpace
                ? Matrix4x4.CreateFromQuaternion(gizmoOrientation)
                : Matrix4x4.Identity;
            var model = Matrix4x4.CreateScale(gizmoScale) * orientMatrix
                * Matrix4x4.CreateTranslation(gizmoCenter);

            float[] verts;
            uint[] indices;
            AxisSection[] sections;
            GetModeGeometry(out verts, out indices, out sections);

            gl.Disable(EnableCap.DepthTest);
            gl.Enable(EnableCap.Blend);
            gl.BlendFunc(BlendingFactor.SrcAlpha, BlendingFactor.OneMinusSrcAlpha);
            gl.Disable(EnableCap.CullFace);

            _shader.Bind();
            _shader.SetUniform("uViewProjection", viewProjection);
            _shader.SetUniform("uModel", model);
            _shader.SetUniform("uAlpha", 1.0f);

            gl.BindVertexArray(_vao);
            gl.BindBuffer(GLEnum.ArrayBuffer, _vbo);
            fixed (float* vp = verts) {
                gl.BufferData(GLEnum.ArrayBuffer, (nuint)(verts.Length * sizeof(float)), vp, GLEnum.DynamicDraw);
            }
            gl.BindBuffer(GLEnum.ElementArrayBuffer, _ebo);
            fixed (uint* ip = indices) {
                gl.BufferData(GLEnum.ElementArrayBuffer, (nuint)(indices.Length * sizeof(uint)), ip, GLEnum.DynamicDraw);
            }

            foreach (var section in sections) {
                bool isHovered = section.Axis == HoveredAxis && !IsDragging;
                bool isActive = section.Axis == ActiveAxis && IsDragging;
                bool isDimmed = IsDragging && section.Axis != ActiveAxis;
                float brightness = isDimmed ? 0.35f : (isHovered || isActive) ? 1.8f : 1.0f;
                _shader.SetUniform("uBrightness", brightness);
                gl.DrawElements(GLEnum.Triangles, (uint)section.IndexCount, GLEnum.UnsignedInt,
                    (void*)(section.IndexOffset * sizeof(uint)));
            }

            gl.BindVertexArray(0);
            gl.UseProgram(0);
            gl.Enable(EnableCap.DepthTest);
            gl.Enable(EnableCap.CullFace);
            gl.Disable(EnableCap.Blend);
        }

        public unsafe void RenderSelectionBox(GL gl, Matrix4x4 viewProjection, ICamera camera,
            Vector3 min, Vector3 max, Vector3 color) {
            if (!_initialized || _shader == null) return;

            BuildBoxGeometry(min, max, color);

            gl.Enable(EnableCap.DepthTest);
            gl.Enable(EnableCap.Blend);
            gl.BlendFunc(BlendingFactor.SrcAlpha, BlendingFactor.OneMinusSrcAlpha);
            gl.Disable(EnableCap.CullFace);

            _shader.Bind();
            _shader.SetUniform("uViewProjection", viewProjection);
            _shader.SetUniform("uModel", Matrix4x4.Identity);
            _shader.SetUniform("uAlpha", 0.85f);
            _shader.SetUniform("uBrightness", 1.0f);

            gl.BindVertexArray(_boxVAO);
            gl.BindBuffer(GLEnum.ArrayBuffer, _boxVBO);
            fixed (float* vp = _boxVerts) {
                gl.BufferData(GLEnum.ArrayBuffer, (nuint)(_boxVerts.Length * sizeof(float)), vp, GLEnum.DynamicDraw);
            }
            gl.BindBuffer(GLEnum.ElementArrayBuffer, _boxEBO);
            fixed (uint* ip = _boxIndices) {
                gl.BufferData(GLEnum.ElementArrayBuffer, (nuint)(_boxIndices.Length * sizeof(uint)), ip, GLEnum.DynamicDraw);
            }

            gl.DrawElements(GLEnum.Triangles, (uint)_boxIndices.Length, GLEnum.UnsignedInt, null);

            gl.BindVertexArray(0);
            gl.UseProgram(0);
            gl.Enable(EnableCap.CullFace);
            gl.Disable(EnableCap.Blend);
        }

        public void UpdateHover(Vector2 mousePos, ICamera camera, Matrix4x4 viewProjection,
            Vector3 gizmoCenter, Quaternion gizmoOrientation) {
            if (IsDragging) return;
            HoveredAxis = HitTestScreen(mousePos, camera, viewProjection, gizmoCenter, gizmoOrientation);
        }

        public GizmoAxis HitTestScreen(Vector2 mousePos, ICamera camera, Matrix4x4 viewProjection,
            Vector3 gizmoCenter, Quaternion gizmoOrientation) {

            float gizmoScale = ComputeScale(camera, gizmoCenter);
            var orient = UseLocalSpace
                ? Matrix4x4.CreateFromQuaternion(gizmoOrientation)
                : Matrix4x4.Identity;
            float sw = camera.ScreenSize.X, sh = camera.ScreenSize.Y;

            var centerScreen = WorldToScreen(gizmoCenter, viewProjection, sw, sh);
            if (!centerScreen.HasValue) return GizmoAxis.None;

            if (Mode == GizmoMode.Translate || Mode == GizmoMode.Scale) {
                var axes = new[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ };
                var axisIds = new[] { GizmoAxis.X, GizmoAxis.Y, GizmoAxis.Z };

                if (Mode == GizmoMode.Translate) {
                    var planeAxes = new[] {
                        (GizmoAxis.XY, Vector3.UnitX, Vector3.UnitY),
                        (GizmoAxis.XZ, Vector3.UnitX, Vector3.UnitZ),
                        (GizmoAxis.YZ, Vector3.UnitY, Vector3.UnitZ)
                    };
                    foreach (var (axis, a1, a2) in planeAxes) {
                        var d1 = Vector3.Transform(a1, orient);
                        var d2 = Vector3.Transform(a2, orient);
                        var handleCenter = gizmoCenter + (d1 + d2) * (PlaneHandleOffset * gizmoScale);
                        var hScreen = WorldToScreen(handleCenter, viewProjection, sw, sh);
                        if (hScreen.HasValue && Vector2.Distance(mousePos, hScreen.Value) < HitThresholdPx * 1.2f)
                            return axis;
                    }
                }

                float closestDist = float.MaxValue;
                GizmoAxis closestAxis = GizmoAxis.None;
                for (int i = 0; i < 3; i++) {
                    var dir = Vector3.Transform(axes[i], orient);
                    var endWorld = gizmoCenter + dir * (ArrowLength * gizmoScale);
                    var endScreen = WorldToScreen(endWorld, viewProjection, sw, sh);
                    if (endScreen == null) continue;
                    float dist = PointToSegmentDist(mousePos, centerScreen.Value, endScreen.Value);
                    if (dist < HitThresholdPx && dist < closestDist) {
                        closestDist = dist;
                        closestAxis = axisIds[i];
                    }
                }
                return closestAxis;
            }

            if (Mode == GizmoMode.Rotate) {
                var axes = new[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ };
                var axisIds = new[] { GizmoAxis.X, GizmoAxis.Y, GizmoAxis.Z };
                float closestDist = float.MaxValue;
                GizmoAxis closestAxis = GizmoAxis.None;

                for (int i = 0; i < 3; i++) {
                    var axisDir = Vector3.Transform(axes[i], orient);
                    var perp1 = GetPerpendicular(axisDir);
                    var perp2 = Vector3.Cross(axisDir, perp1);

                    float bestSegDist = float.MaxValue;
                    for (int s = 0; s < RingSegments; s++) {
                        float a1 = 2f * MathF.PI * s / RingSegments;
                        float a2 = 2f * MathF.PI * (s + 1) / RingSegments;
                        var p1 = gizmoCenter + (perp1 * MathF.Cos(a1) + perp2 * MathF.Sin(a1)) * (RingRadius * gizmoScale);
                        var p2 = gizmoCenter + (perp1 * MathF.Cos(a2) + perp2 * MathF.Sin(a2)) * (RingRadius * gizmoScale);
                        var s1 = WorldToScreen(p1, viewProjection, sw, sh);
                        var s2 = WorldToScreen(p2, viewProjection, sw, sh);
                        if (s1 == null || s2 == null) continue;
                        float d = PointToSegmentDist(mousePos, s1.Value, s2.Value);
                        if (d < bestSegDist) bestSegDist = d;
                    }
                    if (bestSegDist < HitThresholdPx && bestSegDist < closestDist) {
                        closestDist = bestSegDist;
                        closestAxis = axisIds[i];
                    }
                }
                return closestAxis;
            }

            return GizmoAxis.None;
        }

        public bool StartDrag(GizmoAxis axis, Vector2 mousePos, ICamera camera, Matrix4x4 viewProjection,
            Vector3 gizmoCenter, Quaternion gizmoOrientation) {
            if (axis == GizmoAxis.None) return false;
            ActiveAxis = axis;

            float gizmoScale = ComputeScale(camera, gizmoCenter);
            var orient = UseLocalSpace
                ? Matrix4x4.CreateFromQuaternion(gizmoOrientation)
                : Matrix4x4.Identity;

            if (Mode == GizmoMode.Translate || Mode == GizmoMode.Scale) {
                _dragAxisDir = GetAxisDirection(axis, orient);
                var viewDir = Vector3.Normalize(gizmoCenter - camera.Position);

                if (axis == GizmoAxis.XY || axis == GizmoAxis.XZ || axis == GizmoAxis.YZ) {
                    _dragPlaneNormal = GetPlaneNormal(axis, orient);
                } else {
                    var cross = Vector3.Cross(viewDir, _dragAxisDir);
                    _dragPlaneNormal = Vector3.Normalize(Vector3.Cross(_dragAxisDir, cross));
                }

                _dragPlaneOrigin = gizmoCenter;
                var ray = BuildRay(mousePos, camera);
                var hit = RayPlaneIntersect(ray.origin, ray.dir, _dragPlaneOrigin, _dragPlaneNormal);
                _dragStartHit = hit ?? gizmoCenter;
            }

            if (Mode == GizmoMode.Rotate) {
                _dragAxisDir = GetAxisDirection(axis, orient);
                _dragPlaneNormal = _dragAxisDir;
                _dragPlaneOrigin = gizmoCenter;
                var ray = BuildRay(mousePos, camera);
                var hit = RayPlaneIntersect(ray.origin, ray.dir, _dragPlaneOrigin, _dragPlaneNormal);
                if (hit.HasValue) {
                    var offset = hit.Value - gizmoCenter;
                    _dragStartAngle = MathF.Atan2(
                        Vector3.Dot(offset, Vector3.Cross(_dragAxisDir, GetPerpendicular(_dragAxisDir))),
                        Vector3.Dot(offset, GetPerpendicular(_dragAxisDir)));
                }
            }

            return true;
        }

        public Vector3 ComputeTranslateDelta(Vector2 mousePos, ICamera camera, Vector3 gizmoCenter) {
            if (!IsDragging || Mode != GizmoMode.Translate) return Vector3.Zero;
            var ray = BuildRay(mousePos, camera);
            var hit = RayPlaneIntersect(ray.origin, ray.dir, _dragPlaneOrigin, _dragPlaneNormal);
            if (!hit.HasValue) return Vector3.Zero;

            var delta = hit.Value - _dragStartHit;
            if (ActiveAxis == GizmoAxis.X || ActiveAxis == GizmoAxis.Y || ActiveAxis == GizmoAxis.Z) {
                return _dragAxisDir * Vector3.Dot(delta, _dragAxisDir);
            }
            return delta;
        }

        public float ComputeRotationAngle(Vector2 mousePos, ICamera camera, Vector3 gizmoCenter) {
            if (!IsDragging || Mode != GizmoMode.Rotate) return 0f;
            var ray = BuildRay(mousePos, camera);
            var hit = RayPlaneIntersect(ray.origin, ray.dir, _dragPlaneOrigin, _dragPlaneNormal);
            if (!hit.HasValue) return 0f;

            var perp = GetPerpendicular(_dragAxisDir);
            var offset = hit.Value - gizmoCenter;
            float angle = MathF.Atan2(
                Vector3.Dot(offset, Vector3.Cross(_dragAxisDir, perp)),
                Vector3.Dot(offset, perp));
            return angle - _dragStartAngle;
        }

        public Quaternion GetRotationAxis() {
            if (!IsDragging || Mode != GizmoMode.Rotate) return Quaternion.Identity;
            return Quaternion.Identity;
        }

        public Vector3 GetRotationAxisDirection() => _dragAxisDir;

        public Vector3 ComputeScaleDelta(Vector2 mousePos, ICamera camera, Vector3 gizmoCenter) {
            if (!IsDragging || Mode != GizmoMode.Scale) return Vector3.Zero;
            var ray = BuildRay(mousePos, camera);
            var hit = RayPlaneIntersect(ray.origin, ray.dir, _dragPlaneOrigin, _dragPlaneNormal);
            if (!hit.HasValue) return Vector3.Zero;

            var delta = hit.Value - _dragStartHit;
            float axisDelta = Vector3.Dot(delta, _dragAxisDir);
            float scaleFactor = axisDelta / ComputeScale(camera, gizmoCenter);

            return ActiveAxis switch {
                GizmoAxis.X => new Vector3(scaleFactor, 0, 0),
                GizmoAxis.Y => new Vector3(0, scaleFactor, 0),
                GizmoAxis.Z => new Vector3(0, 0, scaleFactor),
                GizmoAxis.All => new Vector3(scaleFactor, scaleFactor, scaleFactor),
                _ => Vector3.Zero
            };
        }

        public void EndDrag() {
            ActiveAxis = GizmoAxis.None;
        }

        public void CancelDrag() {
            ActiveAxis = GizmoAxis.None;
        }

        private void GetModeGeometry(out float[] verts, out uint[] indices, out AxisSection[] sections) {
            switch (Mode) {
                case GizmoMode.Translate:
                    verts = _translateVerts; indices = _translateIndices; sections = _translateSections; break;
                case GizmoMode.Rotate:
                    verts = _rotateVerts; indices = _rotateIndices; sections = _rotateSections; break;
                case GizmoMode.Scale:
                    verts = _scaleVerts; indices = _scaleIndices; sections = _scaleSections; break;
                default:
                    verts = _translateVerts; indices = _translateIndices; sections = _translateSections; break;
            }
        }

        private float ComputeScale(ICamera camera, Vector3 center) {
            if (camera is OrthographicTopDownCamera ortho)
                return ortho.OrthographicSize * 0.15f;
            return Vector3.Distance(camera.Position, center) * ScreenScaleFactor;
        }

        #region Geometry Building

        private void BuildTranslateGeometry() {
            var verts = new List<float>();
            var indices = new List<uint>();
            var sections = new List<AxisSection>();

            var axesData = new[] {
                (Vector3.UnitX, Red, GizmoAxis.X),
                (Vector3.UnitY, Green, GizmoAxis.Y),
                (Vector3.UnitZ, Blue, GizmoAxis.Z)
            };

            foreach (var (axis, color, gizmoAxis) in axesData) {
                int idxOff = indices.Count;
                var shaftEnd = axis * ArrowLength;
                var tipEnd = axis * (ArrowLength + TipLength);
                AddBox(verts, indices, Vector3.Zero, shaftEnd, ShaftThickness, color);
                AddCone(verts, indices, shaftEnd, tipEnd, TipRadius, color, ConeSides);
                sections.Add(new AxisSection { Axis = gizmoAxis, IndexOffset = idxOff, IndexCount = indices.Count - idxOff });
            }

            var planeData = new[] {
                (GizmoAxis.XY, Vector3.UnitX, Vector3.UnitY, Yellow),
                (GizmoAxis.XZ, Vector3.UnitX, Vector3.UnitZ, Magenta),
                (GizmoAxis.YZ, Vector3.UnitY, Vector3.UnitZ, Cyan)
            };
            foreach (var (gizmoAxis, a1, a2, color) in planeData) {
                int idxOff = indices.Count;
                var center = (a1 + a2) * PlaneHandleOffset;
                var corners = new[] {
                    center + (a1 + a2) * (PlaneHandleSize * 0.5f),
                    center + (a1 - a2) * (PlaneHandleSize * 0.5f),
                    center + (-a1 - a2) * (PlaneHandleSize * 0.5f),
                    center + (-a1 + a2) * (PlaneHandleSize * 0.5f),
                };
                AddQuad(verts, indices, corners[0], corners[1], corners[2], corners[3], color);
                sections.Add(new AxisSection { Axis = gizmoAxis, IndexOffset = idxOff, IndexCount = indices.Count - idxOff });
            }

            _translateVerts = verts.ToArray();
            _translateIndices = indices.ToArray();
            _translateSections = sections.ToArray();
        }

        private void BuildRotateGeometry() {
            var verts = new List<float>();
            var indices = new List<uint>();
            var sections = new List<AxisSection>();

            var axesData = new[] {
                (Vector3.UnitX, Red, GizmoAxis.X),
                (Vector3.UnitY, Green, GizmoAxis.Y),
                (Vector3.UnitZ, Blue, GizmoAxis.Z)
            };

            foreach (var (axis, color, gizmoAxis) in axesData) {
                int idxOff = indices.Count;
                AddRing(verts, indices, axis, RingRadius, RingThickness, color, RingSegments);
                sections.Add(new AxisSection { Axis = gizmoAxis, IndexOffset = idxOff, IndexCount = indices.Count - idxOff });
            }

            _rotateVerts = verts.ToArray();
            _rotateIndices = indices.ToArray();
            _rotateSections = sections.ToArray();
        }

        private void BuildScaleGeometry() {
            var verts = new List<float>();
            var indices = new List<uint>();
            var sections = new List<AxisSection>();

            var axesData = new[] {
                (Vector3.UnitX, Red, GizmoAxis.X),
                (Vector3.UnitY, Green, GizmoAxis.Y),
                (Vector3.UnitZ, Blue, GizmoAxis.Z)
            };

            foreach (var (axis, color, gizmoAxis) in axesData) {
                int idxOff = indices.Count;
                var shaftEnd = axis * ArrowLength;
                AddBox(verts, indices, Vector3.Zero, shaftEnd, ShaftThickness, color);
                AddCube(verts, indices, shaftEnd, CubeHalfSize, color);
                sections.Add(new AxisSection { Axis = gizmoAxis, IndexOffset = idxOff, IndexCount = indices.Count - idxOff });
            }

            int centerOff = indices.Count;
            AddCube(verts, indices, Vector3.Zero, CubeHalfSize * 0.8f, White);
            sections.Add(new AxisSection { Axis = GizmoAxis.All, IndexOffset = centerOff, IndexCount = indices.Count - centerOff });

            _scaleVerts = verts.ToArray();
            _scaleIndices = indices.ToArray();
            _scaleSections = sections.ToArray();
        }

        private void BuildBoxGeometry(Vector3 min, Vector3 max, Vector3 color) {
            var verts = new List<float>();
            var indices = new List<uint>();
            float t = 0.02f * Vector3.Distance(min, max);
            t = MathF.Max(t, 0.05f);

            var corners = new Vector3[8];
            corners[0] = new(min.X, min.Y, min.Z);
            corners[1] = new(max.X, min.Y, min.Z);
            corners[2] = new(max.X, max.Y, min.Z);
            corners[3] = new(min.X, max.Y, min.Z);
            corners[4] = new(min.X, min.Y, max.Z);
            corners[5] = new(max.X, min.Y, max.Z);
            corners[6] = new(max.X, max.Y, max.Z);
            corners[7] = new(min.X, max.Y, max.Z);

            var edges = new[] {
                (0,1),(1,2),(2,3),(3,0),
                (4,5),(5,6),(6,7),(7,4),
                (0,4),(1,5),(2,6),(3,7)
            };
            foreach (var (a, b) in edges)
                AddBox(verts, indices, corners[a], corners[b], t, color);

            _boxVerts = verts.ToArray();
            _boxIndices = indices.ToArray();
        }

        private static void AddBox(List<float> verts, List<uint> indices,
            Vector3 from, Vector3 to, float thickness, Vector3 color) {
            var dir = to - from;
            float len = dir.Length();
            if (len < 1e-6f) return;
            dir /= len;
            var p1 = GetPerpendicular(dir) * (thickness * 0.5f);
            var p2 = Vector3.Normalize(Vector3.Cross(dir, p1)) * (thickness * 0.5f);

            uint b = (uint)(verts.Count / 6);
            var c = new[] {
                from - p1 - p2, from + p1 - p2, from + p1 + p2, from - p1 + p2,
                to - p1 - p2, to + p1 - p2, to + p1 + p2, to - p1 + p2
            };
            foreach (var v in c) { verts.Add(v.X); verts.Add(v.Y); verts.Add(v.Z); verts.Add(color.X); verts.Add(color.Y); verts.Add(color.Z); }

            var faces = new uint[] {
                0,1,2,0,2,3, 4,6,5,4,7,6,
                0,4,5,0,5,1, 2,6,7,2,7,3,
                0,3,7,0,7,4, 1,5,6,1,6,2
            };
            foreach (var f in faces) indices.Add(b + f);
        }

        private static void AddCone(List<float> verts, List<uint> indices,
            Vector3 baseCenter, Vector3 tip, float radius, Vector3 color, int sides) {
            var dir = Vector3.Normalize(tip - baseCenter);
            var p1 = GetPerpendicular(dir);
            var p2 = Vector3.Cross(dir, p1);

            uint b = (uint)(verts.Count / 6);
            verts.Add(baseCenter.X); verts.Add(baseCenter.Y); verts.Add(baseCenter.Z);
            verts.Add(color.X); verts.Add(color.Y); verts.Add(color.Z);
            verts.Add(tip.X); verts.Add(tip.Y); verts.Add(tip.Z);
            verts.Add(color.X); verts.Add(color.Y); verts.Add(color.Z);

            for (int i = 0; i < sides; i++) {
                float a = 2f * MathF.PI * i / sides;
                var pt = baseCenter + p1 * MathF.Cos(a) * radius + p2 * MathF.Sin(a) * radius;
                verts.Add(pt.X); verts.Add(pt.Y); verts.Add(pt.Z);
                verts.Add(color.X); verts.Add(color.Y); verts.Add(color.Z);
            }

            for (int i = 0; i < sides; i++) {
                int next = (i + 1) % sides;
                indices.Add(b); indices.Add(b + 2 + (uint)i); indices.Add(b + 2 + (uint)next);
                indices.Add(b + 1); indices.Add(b + 2 + (uint)next); indices.Add(b + 2 + (uint)i);
            }
        }

        private static void AddCube(List<float> verts, List<uint> indices,
            Vector3 center, float halfSize, Vector3 color) {
            AddBox(verts, indices,
                center - new Vector3(halfSize, 0, 0),
                center + new Vector3(halfSize, 0, 0),
                halfSize * 2f, color);
        }

        private static void AddRing(List<float> verts, List<uint> indices,
            Vector3 axis, float radius, float thickness, Vector3 color, int segments) {
            var p1 = GetPerpendicular(axis);
            var p2 = Vector3.Cross(axis, p1);

            for (int i = 0; i < segments; i++) {
                float a1 = 2f * MathF.PI * i / segments;
                float a2 = 2f * MathF.PI * ((i + 1) % segments) / segments;
                var pt1 = p1 * MathF.Cos(a1) * radius + p2 * MathF.Sin(a1) * radius;
                var pt2 = p1 * MathF.Cos(a2) * radius + p2 * MathF.Sin(a2) * radius;
                AddBox(verts, indices, pt1, pt2, thickness, color);
            }
        }

        private static void AddQuad(List<float> verts, List<uint> indices,
            Vector3 a, Vector3 b, Vector3 c, Vector3 d, Vector3 color) {
            uint baseIdx = (uint)(verts.Count / 6);
            foreach (var v in new[] { a, b, c, d }) {
                verts.Add(v.X); verts.Add(v.Y); verts.Add(v.Z);
                verts.Add(color.X); verts.Add(color.Y); verts.Add(color.Z);
            }
            indices.Add(baseIdx); indices.Add(baseIdx + 1); indices.Add(baseIdx + 2);
            indices.Add(baseIdx); indices.Add(baseIdx + 2); indices.Add(baseIdx + 3);
            indices.Add(baseIdx + 2); indices.Add(baseIdx + 1); indices.Add(baseIdx);
            indices.Add(baseIdx + 3); indices.Add(baseIdx + 2); indices.Add(baseIdx);
        }

        #endregion

        #region Math Helpers

        private static Vector3 GetPerpendicular(Vector3 v) {
            v = Vector3.Normalize(v);
            var candidate = MathF.Abs(Vector3.Dot(v, Vector3.UnitY)) < 0.9f ? Vector3.UnitY : Vector3.UnitX;
            return Vector3.Normalize(Vector3.Cross(v, candidate));
        }

        private static Vector2? WorldToScreen(Vector3 world, Matrix4x4 vp, float sw, float sh) {
            var clip = Vector4.Transform(new Vector4(world, 1f), vp);
            if (clip.W <= 0.001f) return null;
            float ndcX = clip.X / clip.W;
            float ndcY = clip.Y / clip.W;
            return new Vector2((ndcX + 1f) * 0.5f * sw, (ndcY + 1f) * 0.5f * sh);
        }

        private static float PointToSegmentDist(Vector2 p, Vector2 a, Vector2 b) {
            var ab = b - a;
            float len2 = ab.LengthSquared();
            if (len2 < 1e-6f) return Vector2.Distance(p, a);
            float t = Math.Clamp(Vector2.Dot(p - a, ab) / len2, 0f, 1f);
            var proj = a + ab * t;
            return Vector2.Distance(p, proj);
        }

        private static Vector3 GetAxisDirection(GizmoAxis axis, Matrix4x4 orient) => axis switch {
            GizmoAxis.X => Vector3.Normalize(Vector3.Transform(Vector3.UnitX, orient)),
            GizmoAxis.Y => Vector3.Normalize(Vector3.Transform(Vector3.UnitY, orient)),
            GizmoAxis.Z => Vector3.Normalize(Vector3.Transform(Vector3.UnitZ, orient)),
            _ => Vector3.UnitZ
        };

        private static Vector3 GetPlaneNormal(GizmoAxis axis, Matrix4x4 orient) => axis switch {
            GizmoAxis.XY => Vector3.Normalize(Vector3.Transform(Vector3.UnitZ, orient)),
            GizmoAxis.XZ => Vector3.Normalize(Vector3.Transform(Vector3.UnitY, orient)),
            GizmoAxis.YZ => Vector3.Normalize(Vector3.Transform(Vector3.UnitX, orient)),
            _ => Vector3.UnitZ
        };

        private static Vector3? RayPlaneIntersect(Vector3 origin, Vector3 dir, Vector3 planePoint, Vector3 planeNormal) {
            float denom = Vector3.Dot(planeNormal, dir);
            if (MathF.Abs(denom) < 1e-6f) return null;
            float t = Vector3.Dot(planePoint - origin, planeNormal) / denom;
            if (t < 0) return null;
            return origin + dir * t;
        }

        private static (Vector3 origin, Vector3 dir) BuildRay(Vector2 mousePos, ICamera camera) {
            float sw = camera.ScreenSize.X, sh = camera.ScreenSize.Y;
            float ndcX = 2f * mousePos.X / sw - 1f;
            float ndcY = 2f * mousePos.Y / sh - 1f;
            var vp = camera.GetViewMatrix() * camera.GetProjectionMatrix();
            if (!Matrix4x4.Invert(vp, out var vpInv))
                return (camera.Position, camera.Front);

            var nearW = Vector4.Transform(new Vector4(ndcX, ndcY, -1f, 1f), vpInv);
            var farW = Vector4.Transform(new Vector4(ndcX, ndcY, 1f, 1f), vpInv);
            nearW /= nearW.W;
            farW /= farW.W;
            var origin = new Vector3(nearW.X, nearW.Y, nearW.Z);
            var dir = Vector3.Normalize(new Vector3(farW.X, farW.Y, farW.Z) - origin);
            return (origin, dir);
        }

        #endregion

        public void Dispose() {
            // GPU cleanup is done by SceneContext since it owns the GL context
        }

        public void Dispose(GL gl) {
            if (_vao != 0) gl.DeleteVertexArray(_vao);
            if (_vbo != 0) gl.DeleteBuffer(_vbo);
            if (_ebo != 0) gl.DeleteBuffer(_ebo);
            if (_boxVAO != 0) gl.DeleteVertexArray(_boxVAO);
            if (_boxVBO != 0) gl.DeleteBuffer(_boxVBO);
            if (_boxEBO != 0) gl.DeleteBuffer(_boxEBO);
        }
    }
}
