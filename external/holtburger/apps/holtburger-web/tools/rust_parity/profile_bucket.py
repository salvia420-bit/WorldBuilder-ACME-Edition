#!/usr/bin/env python3
"""Bucket a V8 .cpuprofile's main-thread time by 'what could Rust take'.

Per sample, walk leaf -> root. Output two views:
  1. leaf kind: native WebGL call / three.js renderer JS / three.js scene-graph JS /
     our JS (by file) / wasm / wasm-bindgen glue / (program) / GC / idle
  2. owner: the outermost 'system' frame of ours (a tick/update/render entry) so that
     three.js + GL time spent on behalf of e.g. the shadow pass or the paperdoll is
     charged to it.
Samples under DIAG_FRAMES (bench-only instrumentation) are reported separately.
"""
import json, sys, collections, re

DIAG_FRAMES = {"recordRenderDiag"}  # ?renderDiag=on instrumentation (bench only)

GL_NAMES = set("""
activeTexture attachShader beginQuery bindAttribLocation bindBuffer bindBufferBase bindBufferRange
bindFramebuffer bindRenderbuffer bindSampler bindTexture bindTransformFeedback bindVertexArray
blendColor blendEquation blendEquationSeparate blendFunc blendFuncSeparate blitFramebuffer
bufferData bufferSubData checkFramebufferStatus clear clearBufferfi clearBufferfv clearBufferiv
clearBufferuiv clearColor clearDepth clearStencil clientWaitSync colorMask compileShader
compressedTexImage2D compressedTexImage3D compressedTexSubImage2D compressedTexSubImage3D
copyBufferSubData copyTexImage2D copyTexSubImage2D copyTexSubImage3D createBuffer createFramebuffer
createProgram createQuery createRenderbuffer createSampler createShader createTexture
createTransformFeedback createVertexArray cullFace deleteBuffer deleteFramebuffer deleteProgram
deleteQuery deleteRenderbuffer deleteSampler deleteShader deleteSync deleteTexture
deleteTransformFeedback deleteVertexArray depthFunc depthMask depthRange detachShader disable
disableVertexAttribArray drawArrays drawArraysInstanced drawBuffers drawElements
drawElementsInstanced drawRangeElements enable enableVertexAttribArray endQuery fenceSync finish
flush framebufferRenderbuffer framebufferTexture2D framebufferTextureLayer frontFace
generateMipmap getActiveAttrib getActiveUniform getActiveUniformBlockParameter getActiveUniforms
getAttribLocation getBufferParameter getBufferSubData getContextAttributes getError getExtension
getFragDataLocation getFramebufferAttachmentParameter getIndexedParameter getInternalformatParameter
getParameter getProgramInfoLog getProgramParameter getQuery getQueryParameter
getRenderbufferParameter getSamplerParameter getShaderInfoLog getShaderParameter
getShaderPrecisionFormat getShaderSource getSupportedExtensions getSyncParameter getTexParameter
getTransformFeedbackVarying getUniform getUniformBlockIndex getUniformIndices getUniformLocation
getVertexAttrib getVertexAttribOffset hint invalidateFramebuffer invalidateSubFramebuffer isBuffer
isContextLost isEnabled isFramebuffer isProgram isQuery isRenderbuffer isSampler isShader isSync
isTexture isTransformFeedback isVertexArray lineWidth linkProgram pauseTransformFeedback
pixelStorei polygonOffset readBuffer readPixels renderbufferStorage renderbufferStorageMultisample
resumeTransformFeedback sampleCoverage samplerParameterf samplerParameteri scissor shaderSource
stencilFunc stencilFuncSeparate stencilMask stencilMaskSeparate stencilOp stencilOpSeparate
texImage2D texImage3D texParameterf texParameteri texStorage2D texStorage3D texSubImage2D
texSubImage3D transformFeedbackVaryings uniform1f uniform1fv uniform1i uniform1iv uniform1ui
uniform1uiv uniform2f uniform2fv uniform2i uniform2iv uniform2ui uniform2uiv uniform3f uniform3fv
uniform3i uniform3iv uniform3ui uniform3uiv uniform4f uniform4fv uniform4i uniform4iv uniform4ui
uniform4uiv uniformBlockBinding uniformMatrix2fv uniformMatrix2x3fv uniformMatrix2x4fv
uniformMatrix3fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4fv uniformMatrix4x2fv
uniformMatrix4x3fv useProgram validateProgram vertexAttrib1f vertexAttrib1fv vertexAttrib2f
vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f vertexAttrib4fv vertexAttribDivisor
vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv vertexAttribIPointer
vertexAttribPointer viewport waitSync
multiDrawArraysWEBGL multiDrawElementsWEBGL multiDrawArraysInstancedWEBGL
multiDrawElementsInstancedWEBGL drawArraysInstancedBaseInstanceWEBGL
drawElementsInstancedBaseVertexBaseInstanceWEBGL multiDrawArraysInstancedBaseInstanceWEBGL
multiDrawElementsInstancedBaseVertexBaseInstanceWEBGL queryCounterEXT
""".split())

THREE_GRAPH = re.compile(r"^(updateMatrixWorld|updateWorldMatrix|updateMatrix|multiplyMatrices|"
                         r"compose|decompose|makeRotationFromQuaternion|setFromQuaternion|"
                         r"setFromEuler|setFromRotationMatrix|multiply|premultiply|copy|"
                         r"lookAt|getWorldPosition|getWorldQuaternion|applyMatrix4|invert|"
                         r"traverse|traverseVisible|_onChangeCallback|setFromMatrixPosition)$")


def load(path):
    p = json.load(open(path))
    nodes = {n["id"]: n for n in p["nodes"]}
    parent = {}
    for n in p["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]
    return p, nodes, parent


def fname(n):
    return n["callFrame"]["functionName"] or "(anon)"


def furl(n):
    return n["callFrame"]["url"].split("/")[-1].split("?")[0]


def leaf_kind(n):
    f, u = fname(n), furl(n)
    if f in ("(idle)", "(program)", "(garbage collector)", "(root)"):
        return f
    if not u:
        if f in GL_NAMES:
            return "native: WebGL call"
        return "native: other builtin (" + f + ")"
    if u.endswith(".wasm"):
        return "wasm (Rust)"
    if u == "holtburger_web.js":
        return "wasm-bindgen glue JS"
    if u in ("three.module.js", "three.core.js"):
        if THREE_GRAPH.match(f.split(".")[-1]):
            return "three.js scene graph / math"
        return "three.js renderer & other"
    if "postprocessing" in u or u.startswith("index-") or u in ("takram", "clouds.js", "atmosphere.js"):
        return "vendor JS (" + u + ")"
    return "our JS: " + u


def main(paths, topn=45):
    for path in paths:
        p, nodes, parent = load(path)
        tot = (p["endTime"] - p["startTime"]) / 1000.0
        kinds = collections.Counter()
        ours_by_file = collections.Counter()
        diag = 0.0
        owners = collections.Counter()
        three_render_incl = 0.0
        for sid, dt in zip(p["samples"], p["timeDeltas"]):
            ms = dt / 1000.0
            # stack leaf->root
            stack = []
            x = sid
            while x is not None:
                stack.append(nodes[x])
                x = parent.get(x)
            names = [fname(n) for n in stack]
            if any(nm in DIAG_FRAMES for nm in names):
                diag += ms
                continue
            k = leaf_kind(stack[0])
            kinds[k] += ms
            if k.startswith("our JS"):
                ours_by_file[k[8:]] += ms
            if any(fname(n) == "WebGLRenderer.render" for n in stack):
                three_render_incl += ms
        busy = tot - kinds.get("(idle)", 0) - diag
        print(f"=== {path}: {tot:.0f} ms profile, diag excluded {diag:.0f} ms, busy {busy:.0f} ms")
        print("  inside WebGLRenderer.render (incl. hooks + GL):"
              f" {three_render_incl:8.1f} ms {100*three_render_incl/busy:5.1f}% of busy")
        agg = collections.Counter()
        for k, v in kinds.items():
            if k.startswith("our JS"):
                agg["our JS (all files)"] += v
            elif k.startswith("native: other builtin"):
                agg["native: other builtin"] += v
            elif k.startswith("vendor JS"):
                agg["vendor JS"] += v
            else:
                agg[k] += v
        for k, v in agg.most_common():
            print(f"  {k:36s} {v:8.1f} ms {100*v/busy:5.1f}%")
        print("  -- our JS self time by file (top):")
        for k, v in ours_by_file.most_common(topn):
            print(f"     {k:40s} {v:7.1f} ms {100*v/busy:5.1f}%")
        nb = collections.Counter({k: v for k, v in kinds.items() if k.startswith("native: other")})
        print("  -- native other builtins (top):")
        for k, v in nb.most_common(12):
            print(f"     {k:60s} {v:7.1f} ms")
        vj = collections.Counter({k: v for k, v in kinds.items() if k.startswith("vendor")})
        for k, v in vj.most_common(8):
            print(f"     {k:60s} {v:7.1f} ms")


if __name__ == "__main__":
    main(sys.argv[1:])
