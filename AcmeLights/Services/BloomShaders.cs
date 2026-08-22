namespace AcmeLights.Services {
    /// <summary>
    /// MILESTONE P5 (AcmeBloom) -- HLSL for the luminance/bloom post-process, compiled at runtime by
    /// D3DCompiler for the CLIENT'S OWN D3D9 device (which supports shaders even though the retail
    /// client never uses them -- confirmed pure fixed-function). ps_2_0 / vs_2_0 profiles for broad
    /// D3D9 hardware compatibility (a separable gaussian + bright-pass fits ps_2_0's instruction
    /// budget comfortably).
    ///
    /// This reproduces holtburger's glow look (pmndrs bloom: luminance threshold ~0.85, mipmap-blur,
    /// additive) so that the client's already-rendered emissive channel (luminosity -> D3D Emissive:
    /// portals, war-spell projectiles, luminous fragments, glowing creatures, torch coronas) reads as
    /// "great lighting" the way it does in holtburger-web. No new light slots -- purely a screen-space
    /// pass over the finished 3D scene, composited additively before the 2D UI is drawn.
    ///
    /// Pipeline (all fullscreen quads with a shared passthrough VS):
    ///   1. bright-pass  : sceneTex -> brightTex (half-res)  -- keep (luma - threshold), soft knee
    ///   2. blur H       : brightTex -> tmpTex   -- 9-tap gaussian, horizontal
    ///   3. blur V       : tmpTex    -> blurTex  -- 9-tap gaussian, vertical
    ///      (steps 2-3 optionally repeated for a wider radius)
    ///   4. composite    : additive blurTex over the backbuffer, intensity-scaled
    ///
    /// All coordinates are the standard D3D9 half-texel-corrected fullscreen quad (XYZRHW).
    /// </summary>
    internal static class BloomShaders {

        /// <summary>Passthrough VS: positions arrive already in clip space (XYZRHW-equivalent handled
        /// by the quad); this VS just forwards position + uv for the shader-based path.</summary>
        public const string VsFullscreen = @"
struct VSIn  { float4 pos : POSITION; float2 uv : TEXCOORD0; };
struct VSOut { float4 pos : POSITION; float2 uv : TEXCOORD0; };
VSOut main(VSIn i) {
    VSOut o;
    o.pos = i.pos;      // already in projection space (pre-transformed quad)
    o.uv  = i.uv;
    return o;
}";

        /// <summary>Bright-pass: soft-knee luminance threshold. cbuffer-free (ps_2_0) -> constants
        /// via c0 = (threshold, knee, intensityPreScale, _). texel offset in c1.</summary>
        public const string PsBrightPass = @"
sampler2D sceneSamp : register(s0);
float4 params : register(c0);   // x=threshold  y=knee  z=preScale  w=unused
float2 texel  : register(c1);   // 1/srcW, 1/srcH
float4 main(float2 uv : TEXCOORD0) : COLOR {
    // 2x2 box downsample while we're here (source is full-res, target half-res).
    float3 c = tex2D(sceneSamp, uv + texel * float2(-0.5,-0.5)).rgb
             + tex2D(sceneSamp, uv + texel * float2( 0.5,-0.5)).rgb
             + tex2D(sceneSamp, uv + texel * float2(-0.5, 0.5)).rgb
             + tex2D(sceneSamp, uv + texel * float2( 0.5, 0.5)).rgb;
    c *= 0.25;
    float luma = dot(c, float3(0.2126, 0.7152, 0.0722));
    // pmndrs-style soft knee around the threshold.
    float knee = max(params.y, 1e-4);
    float soft = clamp((luma - params.x + knee) / (2.0 * knee), 0.0, 1.0);
    float contrib = max(luma - params.x, soft * soft * knee);
    contrib = max(contrib, 0.0) / max(luma, 1e-4);
    return float4(c * contrib * params.z, 1.0);
}";

        /// <summary>Separable 9-tap gaussian. Direction in c0.xy (texel * axis); weights baked.</summary>
        public const string PsBlur = @"
sampler2D srcSamp : register(s0);
float2 dir : register(c0);   // (texelX,0) for horizontal, (0,texelY) for vertical
float4 main(float2 uv : TEXCOORD0) : COLOR {
    // Normalised gaussian, sigma ~2.0, 9 taps.
    const float w0 = 0.2270270270;
    const float w1 = 0.1945945946;
    const float w2 = 0.1216216216;
    const float w3 = 0.0540540541;
    const float w4 = 0.0162162162;
    float3 c = tex2D(srcSamp, uv).rgb * w0;
    c += tex2D(srcSamp, uv + dir * 1.0).rgb * w1;
    c += tex2D(srcSamp, uv - dir * 1.0).rgb * w1;
    c += tex2D(srcSamp, uv + dir * 2.0).rgb * w2;
    c += tex2D(srcSamp, uv - dir * 2.0).rgb * w2;
    c += tex2D(srcSamp, uv + dir * 3.0).rgb * w3;
    c += tex2D(srcSamp, uv - dir * 3.0).rgb * w3;
    c += tex2D(srcSamp, uv + dir * 4.0).rgb * w4;
    c += tex2D(srcSamp, uv - dir * 4.0).rgb * w4;
    return float4(c, 1.0);
}";

        /// <summary>Composite: sample the blurred bloom and output it scaled by intensity. The host
        /// sets ADDITIVE blend state (SRCBLEND=ONE, DESTBLEND=ONE) so this adds over the backbuffer.
        /// c0.x = intensity.</summary>
        public const string PsComposite = @"
sampler2D bloomSamp : register(s0);
float4 params : register(c0);   // x=intensity
float4 main(float2 uv : TEXCOORD0) : COLOR {
    float3 b = tex2D(bloomSamp, uv).rgb * params.x;
    return float4(b, 1.0);
}";
    }
}
