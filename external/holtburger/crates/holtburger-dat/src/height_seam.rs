//! Per-texel height from a texture — the "seam" operator.
//!
//! This is the signal that drives per-texture 3D amplification: every render
//! surface in the world gets a height field, and [`crate::gfx_subdiv`]
//! displaces a subdivided mesh by it. Ported from the operator that won a
//! 10-way comparison over 46 real architectural textures and 13 ground-truth
//! groups (`/mnt/wbterminal2/gfx-material-agent/relief_op.py`).
//!
//! # Why not the obvious approaches
//!
//! Every brightness-based method fails on real AC art, measured:
//!
//! | operator | Tudor inversion (0 = none) | row banding (1.0 = none) |
//! |---|---|---|
//! | `height_from_luminance` (shipped) | **-0.270** | **1.774** |
//! | luminance directly | -0.231 | 1.000 |
//! | 2D Poisson (Frankot-Chellappa) | **-0.248** | 1.000 |
//! | **seam (this)** | **-0.058** | 1.248 |
//!
//! Poisson fixes the row banding and *not* the polarity — integrating ∇L
//! reconstructs L, so a dark Tudor beam still sinks. That is the trap: on a
//! half-timbered wall the timber is DARK and the plaster LIGHT, so any
//! brightness-as-height pushes the beams *into* the wall.
//!
//! # The idea
//!
//! A joint is a thin **line**, and a thin line recedes whichever way it was
//! painted. A morphological tophat is invariant on any region wider than its
//! structuring element, so a broad timber beam, a plaster panel and a black
//! banner field all contribute *nothing* — only the thin line where two
//! regions meet carves. That is what makes it immune to the polarity trap
//! rather than merely resistant to it.
//!
//! It is deliberately **sign-agnostic**: retail is not consistent about which
//! side of a joint is darker. Mortar is darker than the brick in `0x080000DA`
//! and *lighter* than the stone in `0x08000909`, so a dark-only detector finds
//! nothing on the second. [`SEAM_WHITE`] weights the bright-line half; 1.0
//! triples the Tudor penalty (retail paints a specular edge along beams), 0.0
//! misses light mortar, and 0.5 was the measured knee.
//!
//! # Absolute, never per-texture normalised
//!
//! Every constant here is global. Min/max or percentile stretching per texture
//! is what forces a blank stucco wall to use the full height range — the dead
//! zone below [`GROOVE_MIN`] took the carved fraction on flat textures from
//! 51% to 4%. Do not "improve" this by normalising.

/// Pre-blur sigma in texels. Kills INDEX16 palette dither before any
/// derivative is taken; without it the dither itself reads as seams.
pub const PRE_BLUR: f32 = 0.6;

/// Structuring-element radii, as a fraction of the texture's smaller side, and
/// their weights. Multi-scale so both a fine mortar line and a broad plank gap
/// respond.
pub const GROOVE_FRACS: [f32; 3] = [0.006, 0.012, 0.020];
pub const GROOVE_WEIGHT: [f32; 3] = [1.0, 0.85, 0.65];

/// Dead zone: seam strength below this carves nothing at all. This is the
/// single most important constant — it is what stops a flat wall inventing
/// relief out of its own noise.
pub const GROOVE_MIN: f32 = 0.05;
/// Seam strength at which a groove reaches full depth.
///
/// 0.25 until 2026-07-30, which was tuned for a POM height map where parallax
/// exaggerates. Driving real geometry it was far too conservative: a typical
/// mortar line only reached h~0.93, so mean realised depth over 25 real town
/// surfaces was 6.7% of amplitude. 0.12 takes that to 18.6%.
pub const GROOVE_FULL: f32 = 0.12;

/// Weight of the bright-line half relative to the dark-line half.
pub const SEAM_WHITE: f32 = 0.5;

/// Texels below this alpha are cutout and forced flat — displacing an
/// alpha-cutout card is meaningless.
pub const ALPHA_CUT: f32 = 0.5;

/// Wrapped index — textures tile, so the correct boundary everywhere in this
/// module is periodic, not clamped.
#[inline]
fn wrap(i: i32, n: i32) -> usize {
    (((i % n) + n) % n) as usize
}

/// Separable Gaussian blur with wrap boundary.
fn gaussian_blur(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma <= 0.0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let r = (sigma * 3.0).ceil().max(1.0) as i32;
    let mut k: Vec<f32> = (-r..=r)
        .map(|d| (-(d * d) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = k.iter().sum();
    for v in &mut k {
        *v /= sum;
    }
    let (wi, hi) = (w as i32, h as i32);
    let mut tmp = vec![0.0f32; src.len()];
    for y in 0..hi {
        for x in 0..wi {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                acc += kv * src[y as usize * w + wrap(x + j as i32 - r, wi)];
            }
            tmp[y as usize * w + x as usize] = acc;
        }
    }
    let mut out = vec![0.0f32; src.len()];
    for y in 0..hi {
        for x in 0..wi {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                acc += kv * tmp[wrap(y + j as i32 - r, hi) * w + x as usize];
            }
            out[y as usize * w + x as usize] = acc;
        }
    }
    out
}

/// Grey dilation (`max`) or erosion (`min`) over a `(2r+1)` square, wrapped.
/// Separable, so cost is O(n·r) rather than O(n·r²).
fn grey_morph(src: &[f32], w: usize, h: usize, r: i32, dilate: bool) -> Vec<f32> {
    let (wi, hi) = (w as i32, h as i32);
    let pick = |a: f32, b: f32| if dilate { a.max(b) } else { a.min(b) };
    let mut tmp = vec![0.0f32; src.len()];
    for y in 0..hi {
        for x in 0..wi {
            let mut acc = src[y as usize * w + x as usize];
            for d in -r..=r {
                acc = pick(acc, src[y as usize * w + wrap(x + d, wi)]);
            }
            tmp[y as usize * w + x as usize] = acc;
        }
    }
    let mut out = vec![0.0f32; src.len()];
    for y in 0..hi {
        for x in 0..wi {
            let mut acc = tmp[y as usize * w + x as usize];
            for d in -r..=r {
                acc = pick(acc, tmp[wrap(y + d, hi) * w + x as usize]);
            }
            out[y as usize * w + x as usize] = acc;
        }
    }
    out
}

#[inline]
fn smoothstep01(x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Internal: the per-texel smoothstepped seam response `t` in `[0, 1]` (1 = a
/// full-depth joint core) plus the alpha channel. `None` on malformed input.
/// This is the shared front half of [`seam_height`] and [`relief_height`].
fn seam_t(rgba: &[u8], w: u32, h: u32) -> Option<(Vec<f32>, Vec<f32>)> {
    let (wu, hu) = (w as usize, h as usize);
    let n = wu.saturating_mul(hu);
    if n == 0 || rgba.len() < n * 4 {
        return None;
    }

    let mut lum = vec![0.0f32; n];
    let mut alpha = vec![0.0f32; n];
    for i in 0..n {
        let r = rgba[i * 4] as f32 / 255.0;
        let g = rgba[i * 4 + 1] as f32 / 255.0;
        let b = rgba[i * 4 + 2] as f32 / 255.0;
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        alpha[i] = rgba[i * 4 + 3] as f32 / 255.0;
    }

    let pre = gaussian_blur(&lum, wu, hu, PRE_BLUR);

    // Multi-scale sign-agnostic thin-line response.
    let smaller = wu.min(hu) as f32;
    let mut radii: Vec<(i32, f32)> = Vec::new();
    for (f, wt) in GROOVE_FRACS.iter().zip(GROOVE_WEIGHT.iter()) {
        let r = ((f * smaller).round() as i32).max(1);
        // De-duplicate: on small textures several fractions collapse to r = 1.
        if !radii.iter().any(|(rr, _)| *rr == r) {
            radii.push((r, *wt));
        }
    }

    let mut strength = vec![0.0f32; n];
    for (r, wt) in radii {
        // closing = erosion(dilation), opening = dilation(erosion).
        let dil = grey_morph(&pre, wu, hu, r, true);
        let closing = grey_morph(&dil, wu, hu, r, false);
        let ero = grey_morph(&pre, wu, hu, r, false);
        let opening = grey_morph(&ero, wu, hu, r, true);
        for i in 0..n {
            let dark = closing[i] - pre[i];
            let bright = pre[i] - opening[i];
            let s = wt * dark.max(SEAM_WHITE * bright);
            if s > strength[i] {
                strength[i] = s;
            }
        }
    }

    let span = (GROOVE_FULL - GROOVE_MIN).max(1e-6);
    let mut t = vec![0.0f32; n];
    for i in 0..n {
        // Cutout texels are forced flat — never carve an alpha card.
        t[i] = if alpha[i] < ALPHA_CUT {
            0.0
        } else {
            smoothstep01((strength[i] - GROOVE_MIN) / span)
        };
    }
    Some((t, alpha))
}

/// Height field in `[0, 1]` from RGBA8 texels: **1 = proud face, 0 = the bottom
/// of a groove**. Displacement is therefore `amplitude * height`, so grooves
/// are carved by leaving them behind and everything still moves outward only.
///
/// Returns an empty `Vec` when the input is malformed or when the texture has
/// no seams at all, which callers should treat as "leave this surface flat"
/// rather than as an error — a blank stucco wall genuinely has no relief.
pub fn seam_height(rgba: &[u8], w: u32, h: u32) -> Vec<f32> {
    let Some((t, _alpha)) = seam_t(rgba, w, h) else {
        return Vec::new();
    };
    let mut carved = false;
    let out: Vec<f32> = t
        .iter()
        .map(|&ti| {
            let v = 1.0 - ti;
            if v < 0.999 {
                carved = true;
            }
            v
        })
        .collect();
    if !carved {
        return Vec::new(); // genuinely flat — tell the caller to skip it
    }
    out
}

/// Line-vs-speckle gate (2026-07-30, the "battle-torn" fix). The tophat is a
/// THIN-LINE detector but it cannot tell a mortar LINE from a plaster POCK —
/// both are thin. On speckled plaster/stucco the pillow stage then turned
/// every pock into a crater and the wall read as shot-up. The discriminator
/// is connected-component SHAPE on the seam mask:
///   - a mortar/joint network is ONE huge connected component (a net),
///   - a plank gap or beam joint is a long, highly ELONGATED component,
///   - speckle is thousands of tiny, round, isolated blobs.
/// Components that are neither large nor elongated are dropped from BOTH the
/// carve and the pillow seeding, so speckled surfaces return to flat without
/// any per-texture label. Elongation is the sqrt of the second-moment
/// eigenvalue ratio (a structure-tensor of the component's own texels).
/// 1% of the tile. A real joint lattice covers several percent; a pock plus
/// its bright tophat ring is well under 1% (measured: a 3-texel pock responds
/// as ~81 texels on 128² = 0.5%). A lone straight line is under this floor
/// too and survives via elongation instead — the area arm exists ONLY for
/// nets, whose loops make their second moments read isotropic.
pub const COMPONENT_MIN_AREA_FRAC: f32 = 0.01;
pub const COMPONENT_MIN_ELONGATION: f32 = 3.0;

/// Pillow radius as a fraction of the texture's smaller side: how far from the
/// nearest joint a region keeps rising before it plateaus. Small on purpose —
/// it only has to round the SHOULDER of a stone/beam/plank; a large radius
/// would turn a big plaster panel into a dome and re-introduce the asymmetry
/// between narrow beams (low peak) and wide panels (high peak).
pub const PILLOW_FRAC: f32 = 0.03;

/// Seam response above which a texel seeds the distance transform (a "joint
/// core"). Below it a texel still *carves* (via `1 - t`) but does not anchor
/// the pillow field.
pub const PILLOW_SEED_T: f32 = 0.5;

/// The line-vs-speckle gate (see [`COMPONENT_MIN_AREA_FRAC`]): zero the seam
/// response of every connected component that is neither a NET (large area —
/// a mortar/joint lattice) nor a LINE (elongated second moments — a plank
/// gap, beam joint, thatch strand). What remains after suppression is
/// structure; what was suppressed was speckle, and a speckle-only texture
/// ends up with no response at all — i.e. flat, which is what stucco is.
fn suppress_speckle(t: &mut [f32], w: usize, h: usize) {
    // ANY nonzero response joins a component: the smoothstep fringe of a blob
    // must be zeroed WITH its blob, or the leftover halo (t up to ~0.15)
    // still reads as "carved" and the texture never exits flat.
    const MEMBER_T: f32 = 0.01;
    let n = w * h;
    let (wi, hi) = (w as i32, h as i32);
    let min_area = ((n as f32) * COMPONENT_MIN_AREA_FRAC).max(48.0) as usize;
    let mut visited = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut texels: Vec<usize> = Vec::new();
    for start in 0..n {
        if visited[start] || t[start] < MEMBER_T {
            continue;
        }
        // Flood-fill one component (4-connectivity, wrapped — textures tile).
        texels.clear();
        visited[start] = true;
        stack.push(start);
        while let Some(i) = stack.pop() {
            texels.push(i);
            let x = (i % w) as i32;
            let y = (i / w) as i32;
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let j = wrap(y + dy, hi) * w + wrap(x + dx, wi);
                if !visited[j] && t[j] >= MEMBER_T {
                    visited[j] = true;
                    stack.push(j);
                }
            }
        }
        if texels.len() >= min_area {
            continue; // net → keep
        }
        // Elongation from the component's second moments. Coordinates are
        // unwrapped into the half-tile window around the first texel so a
        // component crossing the tile seam is measured contiguously (anything
        // bigger than a half-tile is already kept by area above).
        let (x0, y0) = ((texels[0] % w) as f32, (texels[0] / w) as f32);
        let (hw, hh) = (w as f32 / 2.0, h as f32 / 2.0);
        let unwrap1 = |v: f32, half: f32, full: f32| {
            if v > half {
                v - full
            } else if v < -half {
                v + full
            } else {
                v
            }
        };
        let m = texels.len() as f32;
        let (mut mx, mut my) = (0.0f32, 0.0f32);
        let coords: Vec<(f32, f32)> = texels
            .iter()
            .map(|&i| {
                let dx = unwrap1((i % w) as f32 - x0, hw, w as f32);
                let dy = unwrap1((i / w) as f32 - y0, hh, h as f32);
                mx += dx;
                my += dy;
                (dx, dy)
            })
            .collect();
        mx /= m;
        my /= m;
        let (mut sxx, mut syy, mut sxy) = (0.0f32, 0.0, 0.0);
        for &(x, y) in &coords {
            let (dx, dy) = (x - mx, y - my);
            sxx += dx * dx;
            syy += dy * dy;
            sxy += dx * dy;
        }
        sxx /= m;
        syy /= m;
        sxy /= m;
        let tr = sxx + syy;
        let det = sxx * syy - sxy * sxy;
        let disc = ((tr * tr) / 4.0 - det).max(0.0).sqrt();
        let l1 = tr / 2.0 + disc;
        let l2 = (tr / 2.0 - disc).max(1e-6);
        if (l1 / l2).sqrt() >= COMPONENT_MIN_ELONGATION {
            continue; // line → keep
        }
        for &i in &texels {
            t[i] = 0.0; // blob → speckle → suppress
        }
    }
}

/// Height field in `[0, 1]` with **per-region volume**: joints carve exactly
/// like [`seam_height`], and every region BETWEEN joints rises with distance
/// from its nearest joint into a rounded plateau — each stone reads as a
/// pillowed block, each beam as a proud slab, instead of a flat face with
/// engraved lines.
///
/// Same polarity immunity as the seam operator, by construction: the pillow is
/// derived from the TOPOLOGY of the seam mask (a distance transform), never
/// from brightness, so a dark timber beam and a light plaster panel pillow
/// identically and only their shared joint recedes. Broad-region invariance is
/// preserved: no seams ⇒ empty field ⇒ the caller leaves the surface flat —
/// blank stucco still refuses to invent relief.
///
/// Empty-return semantics are identical to [`seam_height`].
pub fn relief_height(rgba: &[u8], w: u32, h: u32) -> Vec<f32> {
    let Some((mut t, alpha)) = seam_t(rgba, w, h) else {
        return Vec::new();
    };
    let (wu, hu) = (w as usize, h as usize);
    let n = wu * hu;

    // The battle-torn fix: drop blob-shaped (speckle) seam components before
    // anything carves or seeds a pillow. A speckle-only texture (plaster,
    // stucco) loses its entire response here and exits empty = flat.
    suppress_speckle(&mut t, wu, hu);

    // Seed the distance transform at joint cores.
    const INF: f32 = 1e9;
    let mut dist = vec![INF; n];
    let mut seeds = 0usize;
    for i in 0..n {
        if t[i] >= PILLOW_SEED_T {
            dist[i] = 0.0;
            seeds += 1;
        }
    }

    let mut carved = false;
    let out: Vec<f32> = if seeds == 0 {
        // Seams exist but none reach core strength — pillowing has nothing to
        // anchor to, so degrade gracefully to the pure seam field.
        t.iter().map(|&ti| 1.0 - ti).collect()
    } else {
        // 3-4 chamfer distance transform with WRAPPED indexing (textures
        // tile). One forward + one backward sweep is exact on a plane; the
        // pair is run twice so distances propagate across the wrap seam —
        // sufficient because the pillow radius is small (~3% of the tile).
        let (wi, hi) = (w as i32, h as i32);
        for _round in 0..2 {
            // forward: left/up neighbourhood
            for y in 0..hi {
                for x in 0..wi {
                    let i = y as usize * wu + x as usize;
                    let mut d = dist[i];
                    let nb = |xx: i32, yy: i32| dist[wrap(yy, hi) * wu + wrap(xx, wi)];
                    d = d.min(nb(x - 1, y) + 1.0);
                    d = d.min(nb(x, y - 1) + 1.0);
                    d = d.min(nb(x - 1, y - 1) + 1.4);
                    d = d.min(nb(x + 1, y - 1) + 1.4);
                    dist[i] = d;
                }
            }
            // backward: right/down neighbourhood
            for y in (0..hi).rev() {
                for x in (0..wi).rev() {
                    let i = y as usize * wu + x as usize;
                    let mut d = dist[i];
                    let nb = |xx: i32, yy: i32| dist[wrap(yy, hi) * wu + wrap(xx, wi)];
                    d = d.min(nb(x + 1, y) + 1.0);
                    d = d.min(nb(x, y + 1) + 1.0);
                    d = d.min(nb(x + 1, y + 1) + 1.4);
                    d = d.min(nb(x - 1, y + 1) + 1.4);
                    dist[i] = d;
                }
            }
        }
        let r = (PILLOW_FRAC * wu.min(hu) as f32).max(2.0);
        (0..n)
            .map(|i| {
                // Cutout texels stay EXACTLY flat (never carve an alpha card),
                // even when they sit next to a seam on the opaque side.
                if alpha[i] < ALPHA_CUT {
                    1.0
                } else {
                    smoothstep01(dist[i] / r) * (1.0 - t[i])
                }
            })
            .collect()
    };
    for &v in &out {
        if v < 0.999 {
            carved = true;
            break;
        }
    }
    if !carved {
        return Vec::new();
    }
    out
}

/// Tangent-space normal map derived from a seam height field, as RGB8 with the
/// usual `n * 0.5 + 0.5` encoding.
///
/// This replaces deriving the normal from raw luminance, which is the same
/// polarity trap as the height: a dark Tudor beam produces a normal that tilts
/// as though the beam were a trench. Deriving from the seam field instead means
/// the normal agrees with the geometry by construction, and broad regions
/// (which the tophat leaves flat) get a flat normal rather than a spurious one.
///
/// `strength` scales the gradient; 1.0 is neutral.
pub fn seam_normal_rgb8(height: &[f32], w: u32, h: u32, strength: f32) -> Vec<u8> {
    let (wu, hu) = (w as usize, h as usize);
    let n = wu.saturating_mul(hu);
    if n == 0 || height.len() < n {
        return Vec::new();
    }
    let (wi, hi) = (w as i32, h as i32);
    let at = |x: i32, y: i32| height[wrap(y, hi) * wu + wrap(x, wi)];
    let mut out = vec![0u8; n * 3];
    for y in 0..hi {
        for x in 0..wi {
            // Central differences, wrapped — textures tile.
            let dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
            let dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength;
            // Height is in [0,1] over a texel grid; scale so a full-depth
            // groove over one texel reads as a steep wall rather than a ripple.
            let sx = -dx * (wu as f32).min(512.0) * 0.05;
            let sy = -dy * (hu as f32).min(512.0) * 0.05;
            let inv = 1.0 / (sx * sx + sy * sy + 1.0).sqrt();
            let (nx, ny, nz) = (sx * inv, sy * inv, inv);
            let i = (y as usize * wu + x as usize) * 3;
            out[i] = ((nx * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8;
            out[i + 1] = ((ny * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8;
            out[i + 2] = ((nz * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Bilinear sample of a height field at a (tiling) UV.
#[inline]
pub fn sample_height(field: &[f32], w: u32, h: u32, uv: [f32; 2]) -> f32 {
    if field.is_empty() || w == 0 || h == 0 {
        return 1.0;
    }
    let (wi, hi) = (w as i32, h as i32);
    // UVs tile (u > 1 is normal on AC walls), so wrap rather than clamp.
    let fx = uv[0].fract();
    let fy = uv[1].fract();
    let fx = if fx < 0.0 { fx + 1.0 } else { fx };
    let fy = if fy < 0.0 { fy + 1.0 } else { fy };
    let x = fx * w as f32 - 0.5;
    let y = fy * h as f32 - 0.5;
    let x0 = x.floor();
    let y0 = y.floor();
    let tx = x - x0;
    let ty = y - y0;
    let (x0, y0) = (x0 as i32, y0 as i32);
    let g = |xx: i32, yy: i32| field[wrap(yy, hi) * w as usize + wrap(xx, wi)];
    let a = g(x0, y0) * (1.0 - tx) + g(x0 + 1, y0) * tx;
    let b = g(x0, y0 + 1) * (1.0 - tx) + g(x0 + 1, y0 + 1) * tx;
    a * (1.0 - ty) + b * ty
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an RGBA8 texture from a per-texel luminance closure.
    fn tex(w: u32, h: u32, f: impl Fn(u32, u32) -> f32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let l = (f(x, y).clamp(0.0, 1.0) * 255.0) as u8;
                v.extend_from_slice(&[l, l, l, 255]);
            }
        }
        v
    }

    #[test]
    fn a_flat_texture_carves_nothing() {
        // The single most important property: a blank wall must not invent
        // relief out of its own noise. This is what a per-texture min/max
        // stretch would destroy.
        let t = tex(64, 64, |_, _| 0.5);
        assert!(seam_height(&t, 64, 64).is_empty());
    }

    #[test]
    fn a_dark_mortar_line_carves() {
        // Thin dark line on a light field — the ordinary brick case.
        let t = tex(64, 64, |_, y| if y % 16 == 0 { 0.10 } else { 0.75 });
        let hf = seam_height(&t, 64, 64);
        assert!(!hf.is_empty(), "dark mortar produced no relief");
        let on_line = hf[0 * 64 + 5];
        let off_line = hf[8 * 64 + 5];
        assert!(on_line < off_line - 0.2, "line {on_line} vs field {off_line}");
    }

    #[test]
    fn a_light_mortar_line_also_carves() {
        // Retail is NOT consistent: 0x08000909 has mortar LIGHTER than the
        // stone. A dark-only detector finds nothing here, which is why the
        // operator is sign-agnostic.
        let t = tex(64, 64, |_, y| if y % 16 == 0 { 0.90 } else { 0.30 });
        let hf = seam_height(&t, 64, 64);
        assert!(!hf.is_empty(), "light mortar produced no relief");
        let on_line = hf[0 * 64 + 5];
        let off_line = hf[8 * 64 + 5];
        assert!(on_line < off_line - 0.1, "line {on_line} vs field {off_line}");
    }

    #[test]
    fn a_pure_step_between_broad_regions_carves_nothing() {
        // Half dark timber, half light plaster, no shadow line. A tophat is
        // invariant on any region wider than its structuring element, and a
        // morphological closing PRESERVES a step edge — so a bare step carves
        // nothing at all. That is the anti-inversion property in its purest
        // form: brightness-as-height would sink the entire dark half here.
        let t = tex(64, 64, |x, _| if x < 32 { 0.15 } else { 0.80 });
        assert!(
            seam_height(&t, 64, 64).is_empty(),
            "a bare step edge invented relief"
        );
    }

    #[test]
    fn tudor_joint_carves_without_sinking_the_beam() {
        // THE Tudor test, realistic: a dark beam on light plaster with the thin
        // shadow line retail actually paints at the joint. The LINE must carve;
        // the beam's interior must stay level with the plaster's interior.
        // The joint is 3 texels wide and darker than BOTH neighbours — a
        // 1-texel line does not survive the 0.6 px pre-blur, which is itself
        // why PRE_BLUR exists (it kills INDEX16 palette dither).
        let joint = |x: u32| (38..41).contains(&x) || (88..91).contains(&x);
        let t = tex(128, 128, |x, _| {
            if joint(x) {
                0.03
            } else if (41..88).contains(&x) {
                0.20 // broad dark timber
            } else {
                0.80 // broad light plaster
            }
        });
        let hf = seam_height(&t, 128, 128);
        assert!(!hf.is_empty(), "the joint line produced no relief");
        let row = 64 * 128;
        let joint_h = hf[row + 39];
        let in_timber = hf[row + 64];
        let in_plaster = hf[row + 10];
        assert!(joint_h < 0.8, "joint did not carve: {joint_h}");
        assert!(
            (in_timber - in_plaster).abs() < 0.1,
            "POLARITY INVERSION: timber interior {in_timber} vs plaster {in_plaster}"
        );
        assert!(in_timber > 0.9, "dark timber interior sank to {in_timber}");
    }

    #[test]
    fn cutout_texels_are_forced_flat() {
        let mut t = tex(32, 32, |_, y| if y % 8 == 0 { 0.1 } else { 0.9 });
        for i in 0..(32 * 32) {
            t[i * 4 + 3] = 0; // fully transparent everywhere
        }
        let hf = seam_height(&t, 32, 32);
        assert!(hf.is_empty() || hf.iter().all(|v| *v >= 0.999));
    }

    #[test]
    fn malformed_input_is_rejected() {
        assert!(seam_height(&[], 0, 0).is_empty());
        assert!(seam_height(&[0u8; 4], 8, 8).is_empty()); // too short
    }

    #[test]
    fn seam_normal_is_flat_where_the_height_is_flat_and_tilts_at_a_groove() {
        // A flat height field must give the neutral normal (128,128,255) — a
        // broad Tudor beam must NOT tilt, which is exactly what deriving the
        // normal from raw luminance got wrong.
        let flat = vec![1.0f32; 32 * 32];
        let nf = seam_normal_rgb8(&flat, 32, 32, 1.0);
        assert_eq!(nf.len(), 32 * 32 * 3);
        for px in nf.chunks(3) {
            assert!((px[0] as i32 - 128).abs() <= 1, "flat tilted in x: {px:?}");
            assert!((px[1] as i32 - 128).abs() <= 1, "flat tilted in y: {px:?}");
            assert!(px[2] > 250, "flat normal not facing out: {px:?}");
        }
        // A vertical groove must tilt the normal in x somewhere.
        let mut g = vec![1.0f32; 32 * 32];
        for y in 0..32 {
            g[y * 32 + 16] = 0.0;
        }
        let ng = seam_normal_rgb8(&g, 32, 32, 1.0);
        let tilted = ng.chunks(3).any(|px| (px[0] as i32 - 128).abs() > 20);
        assert!(tilted, "a groove produced no normal tilt");
    }

    #[test]
    fn relief_pillows_a_stone_between_joints() {
        // Brick-like rows of dark mortar every 16 texels: the stone INTERIOR
        // must sit higher than its SHOULDER (the texel band next to the
        // joint), and the joint itself must be the lowest — that gradient is
        // what makes each stone read as a rounded block instead of a flat
        // plateau with an engraved line.
        let t = tex(128, 128, |_, y| if y % 32 == 0 { 0.05 } else { 0.75 });
        let hf = relief_height(&t, 128, 128);
        assert!(!hf.is_empty(), "brick rows produced no relief");
        let col = 64usize;
        let joint = hf[0 * 128 + col];
        let shoulder = hf[2 * 128 + col];
        let interior = hf[16 * 128 + col];
        assert!(joint < 0.3, "joint not carved: {joint}");
        assert!(
            shoulder < interior - 0.1,
            "no rounding: shoulder {shoulder} vs interior {interior}"
        );
        assert!(interior > 0.95, "stone interior sank to {interior}");
    }

    #[test]
    fn relief_keeps_the_tudor_polarity_property() {
        // Same setup as tudor_joint_carves_without_sinking_the_beam: with the
        // pillow stage on top, the beam interior and plaster interior must
        // STILL sit level — the pillow comes from topology, not brightness.
        let joint = |x: u32| (38..41).contains(&x) || (88..91).contains(&x);
        let t = tex(128, 128, |x, _| {
            if joint(x) {
                0.03
            } else if (41..88).contains(&x) {
                0.20
            } else {
                0.80
            }
        });
        let hf = relief_height(&t, 128, 128);
        assert!(!hf.is_empty());
        let row = 64 * 128;
        let in_timber = hf[row + 64];
        let in_plaster = hf[row + 10];
        assert!(
            (in_timber - in_plaster).abs() < 0.1,
            "POLARITY INVERSION: timber {in_timber} vs plaster {in_plaster}"
        );
    }

    #[test]
    fn relief_on_a_flat_texture_is_still_empty() {
        let t = tex(64, 64, |_, _| 0.5);
        assert!(relief_height(&t, 64, 64).is_empty());
    }

    #[test]
    fn speckled_plaster_is_suppressed_to_flat() {
        // Dark pocks on a light field — the "battle-torn" case. Every pock is
        // a small round blob (no net, no line), so the component gate drops
        // the entire response and the texture reads FLAT.
        let t = tex(128, 128, |x, y| {
            if (x % 16 < 3) && (y % 16 < 3) { 0.10 } else { 0.80 }
        });
        assert!(
            relief_height(&t, 128, 128).is_empty(),
            "speckle invented relief"
        );
        // The pure seam operator (no gate) still responds — the gate is a
        // relief_height policy, not a change to seam_height's contract.
        assert!(!seam_height(&t, 128, 128).is_empty());
    }

    #[test]
    fn speckle_gate_keeps_lines_while_dropping_dots() {
        // Mortar lines AND pocks on one texture: the lines must still carve
        // and pillow; the isolated pocks must not become craters.
        let t = tex(128, 128, |x, y| {
            if y % 32 == 0 {
                0.05 // full-width mortar line — elongated/net, kept
            } else if (x % 16 < 3) && (y % 16 < 3) {
                0.10 // pock — round blob, dropped
            } else {
                0.75
            }
        });
        let hf = relief_height(&t, 128, 128);
        assert!(!hf.is_empty(), "gate killed the mortar lines too");
        assert!(hf[0 * 128 + 64] < 0.3, "line no longer carves");
        // A pock interior mid-field (y=17, inside a dot) must match a plain
        // field texel at the same distance from the line — no crater.
        let pock = hf[17 * 128 + 1];
        let plain = hf[17 * 128 + 8];
        assert!(
            (pock - plain).abs() < 0.15,
            "pock still carves: {pock} vs plain {plain}"
        );
    }

    #[test]
    fn sampling_wraps_and_is_bounded() {
        let hf = vec![0.0f32, 1.0, 0.0, 1.0];
        for uv in [[0.0, 0.0], [0.9, 0.9], [2.5, -3.25], [-0.1, 7.7]] {
            let v = sample_height(&hf, 2, 2, uv);
            assert!((0.0..=1.0).contains(&v), "uv {uv:?} -> {v}");
        }
        // Empty field must read as "fully proud", i.e. no displacement change.
        assert_eq!(sample_height(&[], 2, 2, [0.5, 0.5]), 1.0);
    }
}
