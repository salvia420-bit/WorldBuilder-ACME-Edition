using System.Numerics;

namespace AcmeSky.Model {
    /// <summary>
    /// One cloud dome. The renderer draws layers far-to-near (painter's order) at
    /// <see cref="Radius"/>-scaled domes centred on the camera. This is the single unit of the
    /// "2-3 layers at different radii + per-layer parallax" architecture: add entries to
    /// <c>SkyRenderer</c>'s layer list and each becomes an independent dome.
    /// </summary>
    public sealed class SkyLayer {
        /// <summary>File name under assets/sky (a .askytex raw BGRA texture).</summary>
        public required string TextureFile;

        /// <summary>Dome radius in world units. Larger = feels farther, less parallax swing.</summary>
        public float Radius = 900f;

        /// <summary>UV scroll speed (texcoord units per second) -- the slow drift of the plate.</summary>
        public Vector2 ScrollVel = new(0.004f, 0.0015f);

        /// <summary>
        /// Per-layer parallax: how much the texture offset shifts per world unit the camera moves,
        /// in UV space. Different values across layers produce inter-layer parallax (the cue retail
        /// cannot give). 0 = locked to the dome (pure skybox). Keep tiny (~1e-5 .. 1e-4).
        /// </summary>
        public float ParallaxFactor = 0f;

        /// <summary>Overall opacity multiplier applied via D3DRS_TEXTUREFACTOR alpha (0..1).</summary>
        public float BaseAlpha = 1f;

        /// <summary>Additive blend (One/One) instead of alpha blend (SrcAlpha/InvSrcAlpha).</summary>
        public bool Additive = false;

        /// <summary>Resolved native IDirect3DTexture9* (filled by SkyRenderer after load).</summary>
        public System.IntPtr Texture = System.IntPtr.Zero;
    }
}
