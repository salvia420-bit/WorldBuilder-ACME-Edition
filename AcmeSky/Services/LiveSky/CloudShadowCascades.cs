using System;
using System.Numerics;

namespace AcmeSky.Services.LiveSky {
    /// <summary>
    /// MILESTONE 4 -- CPU half of the takram three-clouds Beer Shadow Map: the per-frame cascade split +
    /// sun-view matrix computation. Faithful port of
    ///   vendor/takram-three-clouds/src/CascadedShadowMaps.ts          (update / updateIntervals /
    ///                                                                 getFrustumRadius / updateMatrices)
    ///   vendor/takram-three-clouds/src/helpers/splitFrustum.ts        ('practical' PSSM split)
    ///   vendor/takram-three-clouds/src/helpers/FrustumCorners.ts      (setFromCamera / split)
    ///   vendor/takram-three-clouds/src/CloudsEffect.ts updateSharedUniforms (the `distance` term)
    ///
    /// SPACE.  takram runs this in three.js WORLD space and converts to ECEF in the shader. We run it
    /// directly in the shader's "S space" -- GLOBAL AC metres rotated by acToShader, y-up, sea level at
    /// y = 0 -- because that is the one frame every AcmeSky cloud shader already computes in
    /// (`camShader` in CloudShader.cs PSClouds). ECEF = S + (0, bottomRadiusM, 0), so takram's
    /// worldToECEFMatrix / ecefToWorldMatrix / altitudeCorrection collapse to that single translate,
    /// applied inside CloudShadowShader.cs. Keeping the matrices in S rather than ECEF also keeps the
    /// numbers small (|S| &lt;= ~50 km, versus 6,360 km for ECEF), which matters for float32 shadow uv.
    ///
    /// CONVENTIONS.  System.Numerics is row-vector (p * M), which is exactly what the HLSL here uses
    /// (`row_major` + `mul(v, M)`), and CreateLookAt / CreateOrthographicOffCenter are right-handed with
    /// clip z in [0,1] -- the D3D convention the shader's `clip z = 0` near-plane unprojection expects.
    /// The one three.js quirk reproduced verbatim: the per-cascade view matrix has its +Z axis along
    /// -sunDirection (three's `lookAt(center, position)` argument order), which mirrors the shadow map
    /// horizontally versus a naive build. Harmless -- render and lookup share the matrix.
    /// </summary>
    internal sealed class CloudShadowCascades {
        public const int CascadeCount = 3;

        // qualityPresets.ts defaults.shadow + CloudsEffect.ts `new CascadedShadowMaps({ splitLambda: 0.6 })`
        public const float SplitLambda = 0.6f;
        public const float Margin = 0f;      // cascadedShadowMapsDefaults.margin
        public const bool Fade = true;       // cascadedShadowMapsDefaults.fade

        /// <summary>S-space -> cascade clip. Fed to the shader as shadowMatrices[3].</summary>
        public readonly Matrix4x4[] Matrix = new Matrix4x4[CascadeCount];
        /// <summary>Cascade clip -> S space. Fed to the shader as invShadowMatrices[3].</summary>
        public readonly Matrix4x4[] InverseMatrix = new Matrix4x4[CascadeCount];
        /// <summary>LAST frame's <see cref="Matrix"/>. Fed to the shader as shadowReprojMatrices[3].</summary>
        public readonly Matrix4x4[] ReprojectionMatrix = new Matrix4x4[CascadeCount];
        /// <summary>Normalised split interval (near, far) per cascade; .zw unused padding.</summary>
        public readonly Vector4[] Interval = new Vector4[CascadeCount];

        /// <summary>Main-camera forward axis in S space (cascade depth = dot(p - camera, this)).</summary>
        public Vector3 CameraForwardS;
        /// <summary>Main-camera near distance, recovered from the client projection.</summary>
        public float CameraNear;
        /// <summary>Cascade far distance (sky.cfg cloudshadowfar; holtburger measures 5000 m).</summary>
        public float Far;

        private bool _reprojectionValid;
        private readonly Vector3[] _near = new Vector3[4];   // FrustumCorners.near, view space
        private readonly Vector3[] _far = new Vector3[4];    // FrustumCorners.far,  view space
        private readonly float[] _splits = new float[CascadeCount];

        /// <summary>
        /// Recompute every cascade for this frame. Call ONCE per frame, before the shadow passes,
        /// and only when the shadow feature is enabled.
        /// </summary>
        /// <param name="invView">inverse(WorldToView): view -> client render world (Y-up AC).</param>
        /// <param name="invProj">inverse(ViewToClip): NDC -> view.</param>
        /// <param name="cameraPosAcLocal">landblock-LOCAL AC camera position (cam.WorldPos).</param>
        /// <param name="cameraLbOffsetAc">(lbx*192, lby*192, 0), local AC -> global AC.</param>
        /// <param name="acToShader">AC (E,N,U) -> shader y-up S space (pure rotation).</param>
        /// <param name="worldSwizzle">true when the render world is the AC world with y/z swapped.</param>
        /// <param name="sunDirAc">AC-space sun unit direction.</param>
        /// <param name="bottomRadiusM">planet bottom radius in metres (6,360,000).</param>
        /// <param name="shadowFar">cascade far distance in metres.</param>
        /// <param name="mapSize">shadow map size in texels (512).</param>
        public void Update(in Matrix4x4 invView, in Matrix4x4 invProj,
                           Vector3 cameraPosAcLocal, Vector3 cameraLbOffsetAc,
                           in Matrix4x4 acToShader, bool worldSwizzle,
                           Vector3 sunDirAc, float bottomRadiusM,
                           float shadowFar, float mapSize) {
            // Carry this frame's matrices into the reprojection slot BEFORE overwriting them
            // (ShadowPass.copyReprojection: during frame N's render the uniform holds frame N-1's).
            for (int i = 0; i < CascadeCount; i++)
                ReprojectionMatrix[i] = _reprojectionValid ? Matrix[i] : Matrix4x4.Identity;

            // ---- view -> S space, exactly the chain PSClouds performs per pixel ----
            Matrix4x4 swizzle = worldSwizzle ? SwizzleYZ() : Matrix4x4.Identity;
            Matrix4x4 toGlobal = Matrix4x4.CreateTranslation(cameraLbOffsetAc);
            Matrix4x4 viewToS = invView * swizzle * toGlobal * acToShader;

            Vector3 camAcGlobal = SwizzleVec(cameraPosAcLocal, worldSwizzle) + cameraLbOffsetAc;
            Vector3 camS = Vector3.Transform(camAcGlobal, acToShader);
            Vector3 sunS = Vector3.Normalize(Vector3.TransformNormal(SwizzleVec(sunDirAc, false), acToShader));

            // ---- FrustumCorners.setFromCamera(camera, far) ----
            // three unprojects GL NDC z = -1 / +1; D3D near is z = 0. For a perspective projection the
            // far corner clamped to `far` is the near corner scaled by far / |nearZ|, which is what
            // three's `corner.multiplyScalar(min(far / absZ, 1))` produces -- and it needs no far plane
            // from the client projection at all.
            _near[0] = Unproject(invProj, new Vector3(1f, 1f, 0f));
            _near[1] = Unproject(invProj, new Vector3(1f, -1f, 0f));
            _near[2] = Unproject(invProj, new Vector3(-1f, -1f, 0f));
            _near[3] = Unproject(invProj, new Vector3(-1f, 1f, 0f));

            float nearDist = MathF.Abs(_near[0].Z);
            if (!(nearDist > 1e-4f)) nearDist = 10f;   // degenerate projection guard
            CameraNear = nearDist;
            Far = MathF.Max(shadowFar, nearDist * 2f);
            float farScaleFromNear = Far / nearDist;
            for (int i = 0; i < 4; i++) _far[i] = _near[i] * farScaleFromNear;

            // ---- splitFrustum('practical', 3, near, far, 0.6) ----
            SplitPractical(CascadeCount, nearDist, Far, SplitLambda, _splits);
            for (int i = 0; i < CascadeCount; i++)
                Interval[i] = new Vector4(i > 0 ? _splits[i - 1] : 0f, _splits[i], 0f, 0f);

            // ---- CloudsEffect.updateSharedUniforms: light distance grows near the horizon ----
            Vector3 camEcef = camS + new Vector3(0f, bottomRadiusM, 0f);
            Vector3 surfaceNormal = Vector3.Normalize(camEcef);
            float zenithAngle = Vector3.Dot(sunS, surfaceNormal);
            float distance = 1e6f + (1e3f - 1e6f) * zenithAngle;   // three lerp(1e6, 1e3, zenithAngle)

            // ---- CascadedShadowMaps.updateMatrices ----
            Matrix4x4 lightOrientation = LightOrientation(sunS);          // light -> S (rotation)
            Matrix4x4 sToLight = Matrix4x4.Transpose(lightOrientation);   // S -> light
            Matrix4x4 cameraToLight = viewToS * sToLight;

            Vector3 up = new Vector3(0f, 1f, 0f);   // Object3D.DEFAULT_UP in S space

            for (int k = 0; k < CascadeCount; k++) {
                // FrustumCorners.split: linear interpolation of the corner rays.
                float t0 = k > 0 ? _splits[k - 1] : 0f;
                float t1 = k < CascadeCount - 1 ? _splits[k] : 1f;

                float radius = FrustumRadius(t0, t1, nearDist, Far);

                Matrix4x4 projection = Matrix4x4.CreateOrthographicOffCenter(
                    -radius, radius, -radius, radius,
                    -Margin,                 // near
                    radius * 2f + Margin);   // far

                // Bounding box of the split frustum in light space.
                Vector3 bbMin = new Vector3(float.MaxValue);
                Vector3 bbMax = new Vector3(float.MinValue);
                for (int j = 0; j < 4; j++) {
                    Vector3 n = Vector3.Lerp(_near[j], _far[j], t0);
                    Vector3 f = Vector3.Lerp(_near[j], _far[j], t1);
                    if (k == 0) n = _near[j];
                    if (k == CascadeCount - 1) f = _far[j];
                    Vector3 nl = Vector3.Transform(n, cameraToLight);
                    Vector3 fl = Vector3.Transform(f, cameraToLight);
                    bbMin = Vector3.Min(bbMin, Vector3.Min(nl, fl));
                    bbMax = Vector3.Max(bbMax, Vector3.Max(nl, fl));
                }

                Vector3 center = (bbMin + bbMax) * 0.5f;
                center.Z = bbMax.Z + Margin;

                // Round the light-space translation to even texel increments (kills shimmer).
                float texelWidth = (radius * 2f) / mapSize;
                float texelHeight = (radius * 2f) / mapSize;
                center.X = MathF.Round(center.X / texelWidth) * texelWidth;
                center.Y = MathF.Round(center.Y / texelHeight) * texelHeight;

                Vector3 centerS = Vector3.Transform(center, lightOrientation);
                Vector3 position = sunS * distance + centerS;

                // three: inverseViewMatrix.lookAt(center, position, UP).setPosition(position)
                //  -> the camera's +Z axis is normalize(center - position) = -sunDirection.
                // CreateLookAt's zaxis is (eye - target), so target = eye + sunDirection reproduces it.
                Vector3 safeUp = up;
                if (MathF.Abs(Vector3.Dot(Vector3.Normalize(sunS), up)) > 0.9999f) safeUp.Z += 1e-4f;
                Matrix4x4 view = Matrix4x4.CreateLookAt(position, position + sunS, safeUp);

                Matrix4x4 m = view * projection;
                Matrix[k] = m;
                InverseMatrix[k] = Matrix4x4.Invert(m, out var inv) ? inv : Matrix4x4.Identity;
            }

            if (!_reprojectionValid) {
                for (int i = 0; i < CascadeCount; i++) ReprojectionMatrix[i] = Matrix[i];
                _reprojectionValid = true;
            }

            // Main-camera forward in S space, taken from the near-plane centroid so the client's view
            // handedness never matters (dist = dot(p - camera, forward) is positive in front either way).
            Vector3 centroidView = (_near[0] + _near[1] + _near[2] + _near[3]) * 0.25f;
            Vector3 centroidS = Vector3.Transform(centroidView, viewToS);
            Vector3 fwd = centroidS - camS;
            CameraForwardS = fwd.LengthSquared() > 1e-8f ? Vector3.Normalize(fwd) : new Vector3(0f, 0f, -1f);
        }

        /// <summary>Invalidate the reprojection history (device/target reset, teleport, cascade resize).</summary>
        public void Invalidate() => _reprojectionValid = false;

        // ==========================================================================================
        // helpers
        // ==========================================================================================

        /// <summary>CascadedShadowMaps.getFrustumRadius, with the corner lerps inlined.</summary>
        private float FrustumRadius(float t0, float t1, float near, float far) {
            Vector3 f0 = t1 >= 1f ? _far[0] : Vector3.Lerp(_near[0], _far[0], t1);
            Vector3 f2 = t1 >= 1f ? _far[2] : Vector3.Lerp(_near[2], _far[2], t1);
            Vector3 n2 = t0 <= 0f ? _near[2] : Vector3.Lerp(_near[2], _far[2], t0);

            // The two candidate diagonals: across the far plane, and across the whole split frustum.
            float diagonalLength = MathF.Max(Vector3.Distance(f0, f2), Vector3.Distance(f0, n2));

            // Expand the shadow bounds by the fade width.
            if (Fade) {
                float distance = f0.Z / (far - near);
                diagonalLength += 0.25f * distance * distance * (far - near);
            }
            return diagonalLength * 0.5f;
        }

        /// <summary>splitFrustum.ts 'practical' mode (Zhang et al., GPU Gems 3 ch.10).</summary>
        private static void SplitPractical(int count, float near, float far, float lambda, float[] result) {
            for (int i = 0; i < count; i++) {
                float uniform = (near + (far - near) * (i + 1) / count) / far;
                float logarithmic = (near * MathF.Pow(far / near, (i + 1) / (float)count)) / far;
                result[i] = uniform + (logarithmic - uniform) * lambda;
            }
        }

        /// <summary>three's Matrix4.lookAt(0, -sunDirection, UP): a rotation whose +Z axis IS sunDirection.
        /// Returned in row-vector form, so it maps light space -> S space.</summary>
        private static Matrix4x4 LightOrientation(Vector3 sunS) {
            Vector3 z = Vector3.Normalize(sunS);
            Vector3 up = new Vector3(0f, 1f, 0f);
            Vector3 x = Vector3.Cross(up, z);
            if (x.LengthSquared() < 1e-12f) {
                // three.js: nudge `up` when it is parallel to the forward axis.
                if (MathF.Abs(z.Z) > 0.9999f) up.X += 1e-4f; else up.Z += 1e-4f;
                x = Vector3.Cross(up, z);
            }
            x = Vector3.Normalize(x);
            Vector3 y = Vector3.Cross(z, x);
            return new Matrix4x4(
                x.X, x.Y, x.Z, 0f,
                y.X, y.Y, y.Z, 0f,
                z.X, z.Y, z.Z, 0f,
                0f, 0f, 0f, 1f);
        }

        /// <summary>Render world (E,U,N) -> AC (E,N,U): a y/z permutation, in row-vector form.</summary>
        private static Matrix4x4 SwizzleYZ() => new Matrix4x4(
            1f, 0f, 0f, 0f,
            0f, 0f, 1f, 0f,
            0f, 1f, 0f, 0f,
            0f, 0f, 0f, 1f);

        private static Vector3 SwizzleVec(Vector3 v, bool swizzle) =>
            swizzle ? new Vector3(v.X, v.Z, v.Y) : v;

        /// <summary>NDC -> view space (row-vector, perspective divide).</summary>
        private static Vector3 Unproject(in Matrix4x4 invProj, Vector3 ndc) {
            Vector4 v = Vector4.Transform(new Vector4(ndc, 1f), invProj);
            if (MathF.Abs(v.W) < 1e-9f) return new Vector3(v.X, v.Y, v.Z);
            return new Vector3(v.X / v.W, v.Y / v.W, v.Z / v.W);
        }
    }
}
