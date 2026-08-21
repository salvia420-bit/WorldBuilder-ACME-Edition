using System.Numerics;
using AcmeSky.Lib;

namespace AcmeSky.Services {
    /// <summary>
    /// Snapshot-and-restore of every fixed-function device state AcmeSky touches while drawing the
    /// sky, so the client's own draws that follow in the same frame are byte-for-byte unaffected.
    ///
    /// THIS IS THE #1 CORRECTNESS INVARIANT of the plugin. A single leaked render state (say,
    /// leaving Lighting off, or the texture-factor alpha at the sky's value, or a texture-transform
    /// flag set) silently corrupts the client's own rendering for the rest of the frame -- exactly
    /// the class of bug AcmeRedline's tint pass guards against in BeginTintState/EndTintState. We
    /// mirror that discipline: capture with Get* before the first sky draw, restore with Set* after
    /// the last one, every state read back with the same call it is written with.
    ///
    /// What we deliberately do NOT save/restore, with reasons:
    ///   * Stream source: DrawPrimitiveUP resets stream 0 to null internally; the client always
    ///     rebinds its own vertex buffer with SetStreamSource before its next DrawIndexedPrimitive.
    ///   * The stage-0 texture is saved/restored (Get/SetTexture) because we bind our own.
    /// </summary>
    public struct RenderStateGuard {
        private Device _d;

        // render states
        private uint _zEnable, _zWrite, _zFunc, _alphaBlend, _srcBlend, _dstBlend, _cull, _fog,
                     _lighting, _alphaTest, _texFactor, _colorVertex, _colorWrite, _ambient,
                     _specular, _clipping;
        // texture-stage 0
        private uint _colorOp, _colorArg1, _colorArg2, _alphaOp, _alphaArg1, _alphaArg2,
                     _texTransformFlags, _texCoordIndex;
        // sampler 0
        private uint _addrU, _addrV, _magFilter, _minFilter, _mipFilter;
        // transforms + fvf + bound texture
        private Matrix4x4 _world, _view, _proj, _tex0;
        private uint _fvf;
        private System.IntPtr _tex;

        public void Capture(Device d) {
            _d = d;
            _zEnable = d.GetRenderState(D3D9.Rs.ZEnable);
            _zWrite = d.GetRenderState(D3D9.Rs.ZWriteEnable);
            _zFunc = d.GetRenderState(D3D9.Rs.ZFunc);
            _alphaBlend = d.GetRenderState(D3D9.Rs.AlphaBlendEnable);
            _srcBlend = d.GetRenderState(D3D9.Rs.SrcBlend);
            _dstBlend = d.GetRenderState(D3D9.Rs.DestBlend);
            _cull = d.GetRenderState(D3D9.Rs.CullMode);
            _fog = d.GetRenderState(D3D9.Rs.FogEnable);
            _lighting = d.GetRenderState(D3D9.Rs.Lighting);
            _alphaTest = d.GetRenderState(D3D9.Rs.AlphaTestEnable);
            _texFactor = d.GetRenderState(D3D9.Rs.TextureFactor);
            _colorVertex = d.GetRenderState(D3D9.Rs.ColorVertex);
            _colorWrite = d.GetRenderState(D3D9.Rs.ColorWriteEnable);
            _ambient = d.GetRenderState(D3D9.Rs.Ambient);
            _specular = d.GetRenderState(D3D9.Rs.SpecularEnable);
            _clipping = d.GetRenderState(D3D9.Rs.Clipping);

            _colorOp = d.GetTextureStageState(0, D3D9.Tss.ColorOp);
            _colorArg1 = d.GetTextureStageState(0, D3D9.Tss.ColorArg1);
            _colorArg2 = d.GetTextureStageState(0, D3D9.Tss.ColorArg2);
            _alphaOp = d.GetTextureStageState(0, D3D9.Tss.AlphaOp);
            _alphaArg1 = d.GetTextureStageState(0, D3D9.Tss.AlphaArg1);
            _alphaArg2 = d.GetTextureStageState(0, D3D9.Tss.AlphaArg2);
            _texTransformFlags = d.GetTextureStageState(0, D3D9.Tss.TextureTransformFlags);
            _texCoordIndex = d.GetTextureStageState(0, D3D9.Tss.TexCoordIndex);

            _addrU = d.GetSamplerState(0, D3D9.Samp.AddressU);
            _addrV = d.GetSamplerState(0, D3D9.Samp.AddressV);
            _magFilter = d.GetSamplerState(0, D3D9.Samp.MagFilter);
            _minFilter = d.GetSamplerState(0, D3D9.Samp.MinFilter);
            _mipFilter = d.GetSamplerState(0, D3D9.Samp.MipFilter);

            _world = d.GetTransform(D3D9.Ts.World);
            _view = d.GetTransform(D3D9.Ts.View);
            _proj = d.GetTransform(D3D9.Ts.Projection);
            _tex0 = d.GetTransform(D3D9.Ts.Texture0);
            _fvf = d.GetFVF();
            _tex = d.GetTexture(0);
        }

        public void Restore() {
            var d = _d;
            d.SetRenderState(D3D9.Rs.ZEnable, _zEnable);
            d.SetRenderState(D3D9.Rs.ZWriteEnable, _zWrite);
            d.SetRenderState(D3D9.Rs.ZFunc, _zFunc);
            d.SetRenderState(D3D9.Rs.AlphaBlendEnable, _alphaBlend);
            d.SetRenderState(D3D9.Rs.SrcBlend, _srcBlend);
            d.SetRenderState(D3D9.Rs.DestBlend, _dstBlend);
            d.SetRenderState(D3D9.Rs.CullMode, _cull);
            d.SetRenderState(D3D9.Rs.FogEnable, _fog);
            d.SetRenderState(D3D9.Rs.Lighting, _lighting);
            d.SetRenderState(D3D9.Rs.AlphaTestEnable, _alphaTest);
            d.SetRenderState(D3D9.Rs.TextureFactor, _texFactor);
            d.SetRenderState(D3D9.Rs.ColorVertex, _colorVertex);
            d.SetRenderState(D3D9.Rs.ColorWriteEnable, _colorWrite);
            d.SetRenderState(D3D9.Rs.Ambient, _ambient);
            d.SetRenderState(D3D9.Rs.SpecularEnable, _specular);
            d.SetRenderState(D3D9.Rs.Clipping, _clipping);

            d.SetTextureStageState(0, D3D9.Tss.ColorOp, _colorOp);
            d.SetTextureStageState(0, D3D9.Tss.ColorArg1, _colorArg1);
            d.SetTextureStageState(0, D3D9.Tss.ColorArg2, _colorArg2);
            d.SetTextureStageState(0, D3D9.Tss.AlphaOp, _alphaOp);
            d.SetTextureStageState(0, D3D9.Tss.AlphaArg1, _alphaArg1);
            d.SetTextureStageState(0, D3D9.Tss.AlphaArg2, _alphaArg2);
            d.SetTextureStageState(0, D3D9.Tss.TextureTransformFlags, _texTransformFlags);
            d.SetTextureStageState(0, D3D9.Tss.TexCoordIndex, _texCoordIndex);

            d.SetSamplerState(0, D3D9.Samp.AddressU, _addrU);
            d.SetSamplerState(0, D3D9.Samp.AddressV, _addrV);
            d.SetSamplerState(0, D3D9.Samp.MagFilter, _magFilter);
            d.SetSamplerState(0, D3D9.Samp.MinFilter, _minFilter);
            d.SetSamplerState(0, D3D9.Samp.MipFilter, _mipFilter);

            d.SetTransform(D3D9.Ts.World, _world);
            d.SetTransform(D3D9.Ts.View, _view);
            d.SetTransform(D3D9.Ts.Projection, _proj);
            d.SetTransform(D3D9.Ts.Texture0, _tex0);
            d.SetFVF(_fvf);
            d.SetTexture(0, _tex);
        }
    }
}
