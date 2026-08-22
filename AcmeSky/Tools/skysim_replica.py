#!/usr/bin/env python3
"""CPU replica of AcmeSky's M1 atmosphere shader + the client's matrix pipeline.

THE EYES-FREE VALIDATION HARNESS (2026-08-21). This reproduced BOTH live sky bugs
offline and proved they were one bug: the client's D3D render world is the AC world
with y/z swapped (decomp: PrimD3DRender::ScreenToViewTransform, Render::update_viewpoint),
so the un-swizzled reconstruction rolled the sky (up->north) and drew the atmosphere's
horizon as a vertical "seam". Renders the exact PSAtmosphere math against the shipped
.bin LUTs; use the same pattern to pre-validate M2 clouds / M3 stars before touching
the 1070. Run: python3 skysim_replica.py (writes PNGs next to itself).

Renders the sky exactly as AtmosphereShader.PSAtmosphere would, for a synthetic
camera whose WorldToView/ViewToClip are built EXACTLY like the retail client
(Render::update_viewpoint: render-world = AC world with y/z swapped;
D3DXMatrixPerspectiveFovLH). Lets us reproduce/verify the two live bugs
(rotated ray basis, scattering seam) without GPU or eyes.
"""
import os, struct, sys
import numpy as np
from PIL import Image

LUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "sky", "atmosphere")
OUT = os.path.dirname(os.path.abspath(__file__))

# ---------------- LUT loading ----------------
def load_bin(path):
    with open(path, "rb") as f:
        hdr = f.read(32)
        assert hdr[:8] == b"ASKYLUT1"
        w, h, d, ch, bpc, _ = struct.unpack("<6I", hdr[8:])
        data = np.frombuffer(f.read(), dtype=np.float16).astype(np.float32)
    return data.reshape(d, h, w, ch)  # z-major, row y, col x

TRANS = load_bin(f"{LUTDIR}/transmittance.bin")[0]   # (64,256,4)
SCAT  = load_bin(f"{LUTDIR}/scattering.bin")         # (32,128,256,4)
IRRA  = load_bin(f"{LUTDIR}/irradiance.bin")[0]      # (16,64,4)

# ---------------- D3D11-style samplers (linear, clamp) ----------------
def sample2d(tex, u, v):
    H, W, _ = tex.shape
    x = np.clip(u * W - 0.5, 0, W - 1); y = np.clip(v * H - 0.5, 0, H - 1)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, W - 1); y1 = np.minimum(y0 + 1, H - 1)
    fx = (x - x0)[..., None]; fy = (y - y0)[..., None]
    return ((tex[y0, x0] * (1 - fx) + tex[y0, x1] * fx) * (1 - fy) +
            (tex[y1, x0] * (1 - fx) + tex[y1, x1] * fx) * fy)

def sample3d(tex, u, v, w):
    D, H, W, _ = tex.shape
    x = np.clip(u * W - 0.5, 0, W - 1); y = np.clip(v * H - 0.5, 0, H - 1)
    z = np.clip(w * D - 0.5, 0, D - 1)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int); z0 = np.floor(z).astype(int)
    x1 = np.minimum(x0 + 1, W - 1); y1 = np.minimum(y0 + 1, H - 1); z1 = np.minimum(z0 + 1, D - 1)
    fx = (x - x0)[..., None]; fy = (y - y0)[..., None]; fz = (z - z0)[..., None]
    def bil(zi):
        return ((tex[zi, y0, x0] * (1 - fx) + tex[zi, y0, x1] * fx) * (1 - fy) +
                (tex[zi, y1, x0] * (1 - fx) + tex[zi, y1, x1] * fx) * fy)
    return bil(z0) * (1 - fz) + bil(z1) * fz

# ---------------- shader constants ----------------
PI = np.pi
T_W, T_H = 256, 64
S_R, S_MU, S_MUS, S_NU = 32, 128, 32, 8
solar_irradiance = np.array([1.474, 1.8504, 1.91198])
bottom_radius, top_radius = 6360.0, 6420.0
rayleigh_scattering = np.array([0.005802, 0.013558, 0.0331])
mie_scattering = np.array([0.003996] * 3)
mie_g = 0.8
mu_s_min = -0.5
SUN_RAD_TO_LUM = np.array([1.29742301, 0.92382116, 0.87790474])
SKY_RAD_TO_LUM = np.array([1.51834920, 0.94166750, 0.86252701])

def safe_sqrt(a): return np.sqrt(np.maximum(a, 0.0))
def tex_coord(x, n): return 0.5 / n + x * (1.0 - 1.0 / n)
def dist_to_top(r, mu):
    return np.maximum(-r * mu + safe_sqrt(r * r * (mu * mu - 1) + top_radius**2), 0.0)

def transmittance_to_top(r, mu):
    H = np.sqrt(top_radius**2 - bottom_radius**2)
    rho = safe_sqrt(r * r - bottom_radius**2)
    d = dist_to_top(r, mu)
    d_min = top_radius - r; d_max = rho + H
    x_mu = (d - d_min) / (d_max - d_min); x_r = rho / H
    return sample2d(TRANS, tex_coord(x_mu, T_W), tex_coord(x_r, T_H))[..., :3]

def rayleigh_phase(nu): return 3.0 / (16.0 * PI) * (1 + nu * nu)
def mie_phase(g, nu):
    k = 3.0 / (8.0 * PI) * (1 - g * g) / (2 + g * g)
    return k * (1 + nu * nu) / (1 + g * g - 2 * g * nu) ** 1.5

def scattering_uvwz(r, mu, mu_s, nu):
    # intersectsGround = False branch only (port's specialization)
    H = np.sqrt(top_radius**2 - bottom_radius**2)
    rho = safe_sqrt(r * r - bottom_radius**2)
    u_r = tex_coord(rho / H, S_R)
    r_mu = r * mu
    disc = r_mu * r_mu - r * r + bottom_radius**2
    d = -r_mu + safe_sqrt(disc + H * H)
    d_min = top_radius - r; d_max = rho + H
    u_mu = 0.5 + 0.5 * tex_coord((d - d_min) / (d_max - d_min), S_MU // 2)
    d2 = dist_to_top(np.full_like(mu_s, bottom_radius), mu_s)
    d_min2 = top_radius - bottom_radius; d_max2 = H
    a = (d2 - d_min2) / (d_max2 - d_min2)
    D = dist_to_top(np.array(bottom_radius), np.array(mu_s_min))
    A = (D - d_min2) / (d_max2 - d_min2)
    u_mu_s = tex_coord(np.maximum(1 - a / A, 0) / (1 + a), S_MUS)
    u_nu = (nu + 1) / 2
    return u_nu, u_mu_s, u_mu, u_r

def extrapolated_mie(sc4):
    r = sc4[..., 0:1]
    mie = sc4[..., :3] * sc4[..., 3:4] / np.where(r < 1e-5, 1.0, r) * \
        (rayleigh_scattering[0] / mie_scattering[0]) * (mie_scattering / rayleigh_scattering)
    return np.where(r < 1e-5, 0.0, mie)

def combined_scattering(r, mu, mu_s, nu):
    u_nu, u_mu_s, u_mu, u_r = scattering_uvwz(r, mu, mu_s, nu)
    tcx = u_nu * (S_NU - 1)
    tx = np.floor(tcx); lerp = (tcx - tx)[..., None]
    uvw0x = (tx + u_mu_s) / S_NU; uvw1x = (tx + 1 + u_mu_s) / S_NU
    c0 = sample3d(SCAT, uvw0x, u_mu, u_r)
    c1 = sample3d(SCAT, uvw1x, u_mu, u_r)
    comb = c0 * (1 - lerp) + c1 * lerp
    return comb[..., :3], extrapolated_mie(comb)

def get_sky_radiance(cam_km, view, sun):
    r = np.linalg.norm(cam_km, axis=-1)
    rmu = np.sum(cam_km * view, axis=-1)
    mu = rmu / r
    mu_s = np.sum(cam_km * sun, axis=-1) / r
    nu = np.sum(view * sun, axis=-1)
    trans = transmittance_to_top(r, mu)
    scat, mie = combined_scattering(r, mu, mu_s, nu)
    rad = scat * rayleigh_phase(nu)[..., None] + mie * mie_phase(mie_g, nu)[..., None]
    return rad, trans, mu

# ---------------- AgX (three.js) ----------------
M_SRGB2020 = np.array([[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]])
M_2020SRGB = np.array([[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]])
AGX_IN = np.array([[0.856627153315983, 0.137318972929847, 0.11189821299995],
                   [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
                   [0.0482516061458583, 0.101439036467562, 0.811302368396859]])
AGX_OUT = np.array([[1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
                    [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
                    [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]])

def mulrow(v, M):  # HLSL mul(v, M) row-vector
    return v @ M

def agx(color):
    lo, hi = -12.47393, 4.026069
    c = mulrow(color, M_SRGB2020)
    c = mulrow(c, AGX_IN)
    c = np.log2(np.maximum(c, 1e-10))
    c = np.clip((c - lo) / (hi - lo), 0, 1)
    x2 = c * c; x4 = x2 * x2
    c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232
    c = mulrow(c, AGX_OUT)
    c = np.maximum(c, 0) ** 2.2
    c = np.clip(mulrow(c, M_2020SRGB), 0, 1)
    return c

def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c < 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

# ---------------- client-style matrices ----------------
def client_matrices(cam_pos_ac, heading_deg, pitch_deg, fov_rad, aspect, zn=0.25, zf=1000.0):
    """WorldToView exactly as Render::update_viewpoint (render-world = (x,z,y) swizzle of AC),
    ViewToClip = D3DXMatrixPerspectiveFovLH. Row-vector convention."""
    h = np.radians(heading_deg); p = np.radians(pitch_deg)
    # camera frame in AC coords: X=right, Y=forward, Z=up (AC frame convention)
    fwd = np.array([np.sin(h) * np.cos(p), np.cos(h) * np.cos(p), np.sin(p)])
    upw = np.array([0.0, 0.0, 1.0])
    right = np.cross(fwd, upw); right /= np.linalg.norm(right)
    up = np.cross(right, fwd); up /= np.linalg.norm(up)
    X, Y, Z = right, fwd, up
    o = np.asarray(cam_pos_ac, float)
    # p_local = frame-local coords of world origin: (-o.X, -o.Y(fwd), -o.Z(up))
    pl = np.array([-o @ X, -o @ Y, -o @ Z])
    vm = np.zeros((4, 4))
    # columns: 1=Xaxis, 2=Zaxis(up), 3=Yaxis(fwd); rows = renderworld components (x, z, y)!
    # render-world point rw=(ac.x, ac.z, ac.y): view = rw . vm
    # view.x = dot(ac-o, X): rows must be X in order (x-comp, z-comp, y-comp)
    for col, ax in enumerate([X, Z, Y]):
        vm[0, col] = ax[0]; vm[1, col] = ax[2]; vm[2, col] = ax[1]
    vm[3, :3] = [pl[0], pl[2], pl[1]]
    vm[3, 3] = 1.0
    ys = 1.0 / np.tan(fov_rad / 2); xs = ys / aspect
    pm = np.zeros((4, 4))
    pm[0, 0] = xs; pm[1, 1] = ys
    pm[2, 2] = zf / (zf - zn); pm[2, 3] = 1.0
    pm[3, 2] = -zn * zf / (zf - zn)
    return vm, pm

# ---------------- the shader's reconstruction (raymode 0) ----------------
def render(mode, W=480, H=270, heading=0.0, pitch=0.0, t=0.5, outname="sky.png",
           output=0, exposure=5.0, cam_ac=(100.0, 100.0, 50.0)):
    vm, pm = client_matrices(cam_ac, heading, pitch, np.radians(80), W / H)
    inv_view = np.linalg.inv(vm); inv_proj = np.linalg.inv(pm)
    cam_rw = inv_view[3, :3]  # invView.Translation == render-world camera pos

    u = (np.arange(W) + 0.5) / W; v = (np.arange(H) + 0.5) / H
    uu, vv = np.meshgrid(u, v)
    ndc = np.stack([uu * 2 - 1, 1 - vv * 2], -1)
    clip = np.concatenate([ndc, np.ones((H, W, 2))], -1)
    vpos = clip @ inv_proj
    vpos /= vpos[..., 3:4]
    wp = np.concatenate([vpos[..., :3], np.ones((H, W, 1))], -1) @ inv_view
    dir_rw = wp[..., :3] - cam_rw
    dir_rw /= np.linalg.norm(dir_rw, axis=-1, keepdims=True)

    if mode == "buggy":       # ship code today: treat render-world as AC directly
        dir_ac = dir_rw; cam_ac_used = cam_rw
    elif mode == "fixed":     # swizzle render-world (E,U,N) -> AC (E,N,U)
        dir_ac = dir_rw[..., [0, 2, 1]]; cam_ac_used = cam_rw[[0, 2, 1]]
    else:
        raise ValueError(mode)

    # acToShader x,z,-y : shader = (ac.x, ac.z, -ac.y)
    def ac2sh(a):
        return np.stack([a[..., 0], a[..., 2], -a[..., 1]], -1)
    dir_sh = ac2sh(dir_ac)
    cam_sh = ac2sh(np.broadcast_to(cam_ac_used, dir_ac.shape))

    # sun
    t_ = t; head = t_ * 360.0
    elev = np.sin(2 * np.pi * (t_ - 0.25))
    spitch = elev * 67.35 if elev >= 0 else elev * 14.0
    hs = np.radians(head); ps = np.radians(spitch)
    sun_ac = np.array([np.cos(ps) * np.sin(hs), np.cos(ps) * np.cos(hs), np.sin(ps)])
    sun_sh = ac2sh(sun_ac)

    if output == 4:
        img = (dir_ac * 0.5 + 0.5)
    else:
        cam_km = (cam_sh + np.array([0, 6_360_000.0, 0])) * 0.001
        rad, trans, mu = get_sky_radiance(cam_km, dir_sh, sun_sh)
        rad = rad * SKY_RAD_TO_LUM
        # sun disc
        vds = np.sum(dir_sh * sun_sh, -1)
        sun_ang = 0.03
        solar = solar_irradiance / (PI * 0.004675**2) * SUN_RAD_TO_LUM
        disc = (vds > np.cos(sun_ang)).astype(float)[..., None]
        rad = rad + trans * solar * disc
        img = agx(rad * exposure)
        img = lin2srgb(img)

    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(os.path.join(OUT, outname))
    print(f"{outname}: mode={mode} head={heading} pitch={pitch} t={t} "
          f"center px={img[H//2, W//2]}, top px={img[H//8, W//2]}, bottom px={img[7*H//8, W//2]}")

if __name__ == "__main__":
    # Reproduce the live setup: looking north-ish, level camera, noon.
    render("buggy", outname="A_buggy_sky.png")
    render("fixed", outname="B_fixed_sky.png")
    render("buggy", output=4, outname="A_buggy_rayviz.png")
    render("fixed", output=4, outname="B_fixed_rayviz.png")
    # look east (heading 90) to see azimuth behavior
    render("buggy", heading=90, outname="A_buggy_east.png")
    render("fixed", heading=90, outname="B_fixed_east.png")
    # look up
    render("fixed", pitch=45, outname="B_fixed_up45.png")
    # sunset
    render("fixed", heading=270, t=0.75, outname="B_fixed_sunset.png")
