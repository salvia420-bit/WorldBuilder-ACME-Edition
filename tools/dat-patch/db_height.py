"""DeepBump (ML albedo->normal->Frankot-Chellappa height) for a few rsIds.
Run with the deepbump venv python.  Writes <rsId>.npy into dpc-work/dbcache/.
Sign calibrated on the known dark-mortar brick, as eval_deepbump.py does."""
import sys, os
import numpy as np
from PIL import Image
import onnxruntime as ort

TEX = '/mnt/wbterminal2/tex-reexport-2026-07-30/'
OUT = '/mnt/wbterminal2/dpc-work/dbcache/'
sess = ort.InferenceSession('/mnt/wbterminal2/deepbump-eval/deepbump256.onnx',
                            providers=['CPUExecutionProvider'])
inp = sess.get_inputs()[0].name


def poisson(gx, gy):
    h, w = gx.shape
    fy = np.fft.fftfreq(h).reshape(-1, 1) * 2 * np.pi
    fx = np.fft.fftfreq(w).reshape(1, -1) * 2 * np.pi
    den = fx ** 2 + fy ** 2
    den[0, 0] = 1.0
    num = (-1j * fx) * np.fft.fft2(gx) + (-1j * fy) * np.fft.fft2(gy)
    return np.real(np.fft.ifft2(num / den))


def height(rs, y_sign):
    im = Image.open(TEX + rs + '.png').convert('RGB')
    a = np.asarray(im, np.float32) / 255.0
    lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
    l256 = np.asarray(Image.fromarray((lum * 255).astype(np.uint8))
                      .resize((256, 256), Image.BILINEAR), np.float32) / 255.0
    out = sess.run(None, {inp: l256[None, None]})[0][0] * 2.0 - 1.0
    mag = np.sqrt((out * out).sum(0, keepdims=True))
    n = out / np.maximum(mag, 1e-6)
    nz = np.maximum(n[2], 0.05)
    z = poisson(-n[0] / nz, y_sign * (-n[1] / nz))
    z = z - z.min()
    z = z / max(z.max(), 1e-9)
    return z.astype(np.float32), lum


def main():
    os.makedirs(OUT, exist_ok=True)
    # calibrate on 0x0600389E (Surface 0x080000DA, dark mortar brick)
    best = None
    for s in (1.0, -1.0):
        h, lum = height('0x0600389E', s)
        l = np.asarray(Image.fromarray((h * 255).astype(np.uint8))
                       .resize(lum.shape[::-1], Image.BILINEAR), np.float32) / 255.0
        dark = lum <= np.quantile(lum, 0.05)
        sc = float(l[dark].mean() - l.mean())
        if best is None or sc < best[0]:
            best = (sc, s)
    ysign = best[1]
    print('y_sign', ysign, 'score', best[0])
    for rs in sys.argv[1:]:
        h, lum = height(rs, ysign)
        H, W = lum.shape
        hh = np.asarray(Image.fromarray((h * 255).astype(np.uint8))
                        .resize((W, H), Image.BILINEAR), np.float32) / 255.0
        np.save(OUT + rs + '.npy', hh)
        print(rs, hh.shape, 'range %.3f..%.3f' % (hh.min(), hh.max()))


main()
