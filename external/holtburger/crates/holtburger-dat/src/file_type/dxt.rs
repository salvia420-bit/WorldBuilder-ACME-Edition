// Microsoft Public License (Ms-PL)
// MonoGame - Copyright (c) 2009 The MonoGame Team
//
// Block-decompression for DXT1, DXT3, DXT5 (BC1, BC2, BC3) ported from
// `ACE.DatLoader/DxtUtil.cs`. Decode-only; encode is not needed because
// the renderer never re-bakes DAT entries at runtime.
//
// Phase 3 step 4.5b uses these to decode the ~50 DXT1 + ~10 DXT5
// textures referenced by Holtburg's Surface chains, raising the
// per-model colour resolve rate from 54/81 (66.7%) to 81/81 (100%) on
// the test bundle.

/// Decompress a DXT1 (BC1) buffer into RGBA8.
///
/// `imageData` is the raw block stream — one 8-byte block per 4×4
/// pixels, row-major from the top-left in 4-pixel rows. `width` /
/// `height` may be non-multiple-of-4; trailing partial blocks have
/// their leftover pixels skipped.
///
/// DXT1 layout per block: `[u16 c0_rgb565][u16 c1_rgb565][u32 indices]`.
/// Each pixel is a 2-bit index into a 4-colour palette derived from
/// `c0`/`c1`. When `c0 > c1` the palette is opaque-only; when
/// `c0 <= c1` the 4th index encodes a fully-transparent pixel.
pub fn decompress_dxt1(image_data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut out = vec![0u8; w * h * 4];
    let block_count_x = (w + 3) / 4;
    let block_count_y = (h + 3) / 4;
    let mut pos = 0usize;
    for by in 0..block_count_y {
        for bx in 0..block_count_x {
            if pos + 8 > image_data.len() {
                return out;
            }
            decompress_dxt1_block(&image_data[pos..pos + 8], bx, by, w, h, &mut out);
            pos += 8;
        }
    }
    out
}

fn decompress_dxt1_block(block: &[u8], bx: usize, by: usize, w: usize, h: usize, out: &mut [u8]) {
    let c0 = u16::from_le_bytes([block[0], block[1]]);
    let c1 = u16::from_le_bytes([block[2], block[3]]);
    let lookup = u32::from_le_bytes([block[4], block[5], block[6], block[7]]);
    let (r0, g0, b0) = rgb565_to_rgb888(c0);
    let (r1, g1, b1) = rgb565_to_rgb888(c1);

    for by_in in 0..4 {
        for bx_in in 0..4 {
            let index = (lookup >> (2 * (4 * by_in + bx_in))) & 0x03;
            let (r, g, b, a);
            if c0 > c1 {
                match index {
                    0 => { r = r0; g = g0; b = b0; a = 0xFF; }
                    1 => { r = r1; g = g1; b = b1; a = 0xFF; }
                    2 => {
                        r = ((2 * r0 as u32 + r1 as u32) / 3) as u8;
                        g = ((2 * g0 as u32 + g1 as u32) / 3) as u8;
                        b = ((2 * b0 as u32 + b1 as u32) / 3) as u8;
                        a = 0xFF;
                    }
                    _ => {
                        r = ((r0 as u32 + 2 * r1 as u32) / 3) as u8;
                        g = ((g0 as u32 + 2 * g1 as u32) / 3) as u8;
                        b = ((b0 as u32 + 2 * b1 as u32) / 3) as u8;
                        a = 0xFF;
                    }
                }
            } else {
                match index {
                    0 => { r = r0; g = g0; b = b0; a = 0xFF; }
                    1 => { r = r1; g = g1; b = b1; a = 0xFF; }
                    2 => {
                        r = ((r0 as u32 + r1 as u32) / 2) as u8;
                        g = ((g0 as u32 + g1 as u32) / 2) as u8;
                        b = ((b0 as u32 + b1 as u32) / 2) as u8;
                        a = 0xFF;
                    }
                    _ => { r = 0; g = 0; b = 0; a = 0; }
                }
            }
            let px = (bx << 2) + bx_in;
            let py = (by << 2) + by_in;
            if px < w && py < h {
                let off = (py * w + px) << 2;
                out[off] = r;
                out[off + 1] = g;
                out[off + 2] = b;
                out[off + 3] = a;
            }
        }
    }
}

/// Decompress a DXT3 (BC2) buffer. 16-byte blocks: 8-byte alpha
/// (16 × 4-bit explicit alpha values) + 8-byte DXT1-style colour.
pub fn decompress_dxt3(image_data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut out = vec![0u8; w * h * 4];
    let block_count_x = (w + 3) / 4;
    let block_count_y = (h + 3) / 4;
    let mut pos = 0usize;
    for by in 0..block_count_y {
        for bx in 0..block_count_x {
            if pos + 16 > image_data.len() {
                return out;
            }
            decompress_dxt3_block(&image_data[pos..pos + 16], bx, by, w, h, &mut out);
            pos += 16;
        }
    }
    out
}

fn decompress_dxt3_block(block: &[u8], bx: usize, by: usize, w: usize, h: usize, out: &mut [u8]) {
    let alphas = &block[..8];
    let c0 = u16::from_le_bytes([block[8], block[9]]);
    let c1 = u16::from_le_bytes([block[10], block[11]]);
    let lookup = u32::from_le_bytes([block[12], block[13], block[14], block[15]]);
    let (r0, g0, b0) = rgb565_to_rgb888(c0);
    let (r1, g1, b1) = rgb565_to_rgb888(c1);

    for i in 0..16 {
        let by_in = i / 4;
        let bx_in = i % 4;
        let index = (lookup >> (2 * (4 * by_in + bx_in))) & 0x03;
        let alpha_byte = alphas[i / 2];
        let nibble = if i & 1 == 0 { alpha_byte & 0x0F } else { (alpha_byte & 0xF0) >> 4 };
        let a = nibble | (nibble << 4); // 4-bit → 8-bit replicate
        let (r, g, b);
        match index {
            0 => { r = r0; g = g0; b = b0; }
            1 => { r = r1; g = g1; b = b1; }
            2 => {
                r = ((2 * r0 as u32 + r1 as u32) / 3) as u8;
                g = ((2 * g0 as u32 + g1 as u32) / 3) as u8;
                b = ((2 * b0 as u32 + b1 as u32) / 3) as u8;
            }
            _ => {
                r = ((r0 as u32 + 2 * r1 as u32) / 3) as u8;
                g = ((g0 as u32 + 2 * g1 as u32) / 3) as u8;
                b = ((b0 as u32 + 2 * b1 as u32) / 3) as u8;
            }
        }
        let px = (bx << 2) + bx_in;
        let py = (by << 2) + by_in;
        if px < w && py < h {
            let off = (py * w + px) << 2;
            out[off] = r;
            out[off + 1] = g;
            out[off + 2] = b;
            out[off + 3] = a;
        }
    }
}

/// Decompress a DXT5 (BC3) buffer. 16-byte blocks: 8-byte alpha
/// (2 endpoints + 16 × 3-bit indices into an 8-alpha palette) +
/// 8-byte DXT1-style colour.
pub fn decompress_dxt5(image_data: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut out = vec![0u8; w * h * 4];
    let block_count_x = (w + 3) / 4;
    let block_count_y = (h + 3) / 4;
    let mut pos = 0usize;
    for by in 0..block_count_y {
        for bx in 0..block_count_x {
            if pos + 16 > image_data.len() {
                return out;
            }
            decompress_dxt5_block(&image_data[pos..pos + 16], bx, by, w, h, &mut out);
            pos += 16;
        }
    }
    out
}

fn decompress_dxt5_block(block: &[u8], bx: usize, by: usize, w: usize, h: usize, out: &mut [u8]) {
    let alpha0 = block[0];
    let alpha1 = block[1];
    let mut alpha_mask: u64 = 0;
    for i in 0..6 {
        alpha_mask |= (block[2 + i] as u64) << (i * 8);
    }
    let c0 = u16::from_le_bytes([block[8], block[9]]);
    let c1 = u16::from_le_bytes([block[10], block[11]]);
    let lookup = u32::from_le_bytes([block[12], block[13], block[14], block[15]]);
    let (r0, g0, b0) = rgb565_to_rgb888(c0);
    let (r1, g1, b1) = rgb565_to_rgb888(c1);

    for i in 0..16 {
        let by_in = i / 4;
        let bx_in = i % 4;
        let index = (lookup >> (2 * (4 * by_in + bx_in))) & 0x03;
        let alpha_index = ((alpha_mask >> (3 * (4 * by_in + bx_in))) & 0x07) as u32;
        let a: u8 = if alpha_index == 0 {
            alpha0
        } else if alpha_index == 1 {
            alpha1
        } else if alpha0 > alpha1 {
            (((8 - alpha_index) * alpha0 as u32 + (alpha_index - 1) * alpha1 as u32) / 7) as u8
        } else if alpha_index == 6 {
            0
        } else if alpha_index == 7 {
            0xFF
        } else {
            (((6 - alpha_index) * alpha0 as u32 + (alpha_index - 1) * alpha1 as u32) / 5) as u8
        };
        let (r, g, b);
        match index {
            0 => { r = r0; g = g0; b = b0; }
            1 => { r = r1; g = g1; b = b1; }
            2 => {
                r = ((2 * r0 as u32 + r1 as u32) / 3) as u8;
                g = ((2 * g0 as u32 + g1 as u32) / 3) as u8;
                b = ((2 * b0 as u32 + b1 as u32) / 3) as u8;
            }
            _ => {
                r = ((r0 as u32 + 2 * r1 as u32) / 3) as u8;
                g = ((g0 as u32 + 2 * g1 as u32) / 3) as u8;
                b = ((b0 as u32 + 2 * b1 as u32) / 3) as u8;
            }
        }
        let px = (bx << 2) + bx_in;
        let py = (by << 2) + by_in;
        if px < w && py < h {
            let off = (py * w + px) << 2;
            out[off] = r;
            out[off + 1] = g;
            out[off + 2] = b;
            out[off + 3] = a;
        }
    }
}

/// MonoGame's RGB565 → RGB888 expansion. Slightly more accurate than
/// the naive `<< 3` replicate (rounds toward midpoint).
fn rgb565_to_rgb888(color: u16) -> (u8, u8, u8) {
    let mut t = (color >> 11) as u32 * 255 + 16;
    let r = ((t / 32 + t) / 32) as u8;
    t = ((color & 0x07E0) >> 5) as u32 * 255 + 32;
    let g = ((t / 64 + t) / 64) as u8;
    t = (color & 0x001F) as u32 * 255 + 16;
    let b = ((t / 32 + t) / 32) as u8;
    (r, g, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DXT1 block: c0=red (0xF800), c1=blue (0x001F), all-zero indices
    /// → every pixel is c0 (red).
    #[test]
    fn dxt1_block_all_zero_indices_paints_c0() {
        let block: [u8; 8] = [
            0x00, 0xF8, // c0 = 0xF800 (red, RGB565)
            0x1F, 0x00, // c1 = 0x001F (blue)
            0x00, 0x00, 0x00, 0x00, // 16 pixels all → index 0 → c0
        ];
        let rgba = decompress_dxt1(&block, 4, 4);
        assert_eq!(rgba.len(), 64);
        // Pixel (0,0) should be near red. RGB565 expansion: 0xF8 → 0xFF.
        assert!(rgba[0] > 0xF0);
        assert_eq!(rgba[1], 0x00);
        assert_eq!(rgba[2], 0x00);
        assert_eq!(rgba[3], 0xFF);
        // All 16 pixels should match.
        for i in 0..16 {
            let off = i * 4;
            assert_eq!(rgba[off + 1], 0x00, "pixel {} green not zero", i);
            assert_eq!(rgba[off + 2], 0x00, "pixel {} blue not zero", i);
            assert_eq!(rgba[off + 3], 0xFF, "pixel {} alpha not opaque", i);
        }
    }

    /// DXT1 with c0 == c1 takes the c0 <= c1 branch — index 3 = transparent.
    #[test]
    fn dxt1_with_c0_le_c1_index_3_is_transparent() {
        let block: [u8; 8] = [
            0x00, 0x00, // c0 = 0
            0x00, 0x00, // c1 = 0 (so c0 <= c1)
            0xFF, 0xFF, 0xFF, 0xFF, // all indices = 3
        ];
        let rgba = decompress_dxt1(&block, 4, 4);
        for i in 0..16 {
            assert_eq!(rgba[i * 4 + 3], 0x00, "pixel {} should be transparent", i);
        }
    }

    /// DXT5 alpha block: alpha0=255, alpha1=0, all indices=0 → pixel
    /// alpha = alpha0 = 255.
    #[test]
    fn dxt5_alpha_index_0_uses_alpha0() {
        let block: [u8; 16] = [
            0xFF, // alpha0 = 255
            0x00, // alpha1 = 0
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 48 alpha indices, all 0
            0x00, 0xF8, // c0 = 0xF800 (red)
            0x1F, 0x00, // c1 = 0x001F (blue)
            0x00, 0x00, 0x00, 0x00, // colour indices = 0 → c0 (red)
        ];
        let rgba = decompress_dxt5(&block, 4, 4);
        for i in 0..16 {
            assert_eq!(rgba[i * 4 + 3], 0xFF, "pixel {} alpha should be 255", i);
        }
    }

    /// DXT3 alpha is 4-bit explicit. First nibble = 0xF → alpha 0xFF.
    #[test]
    fn dxt3_explicit_alpha_first_pixel() {
        let block: [u8; 16] = [
            0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // alpha bytes
            0x00, 0xF8, // c0 = red
            0x1F, 0x00, // c1 = blue
            0x00, 0x00, 0x00, 0x00, // indices = 0
        ];
        let rgba = decompress_dxt3(&block, 4, 4);
        // Pixel 0: low nibble of byte 0 = 0xF → alpha 0xFF.
        assert_eq!(rgba[3], 0xFF);
        // Pixel 1: high nibble of byte 0 = 0xF → alpha 0xFF.
        assert_eq!(rgba[7], 0xFF);
        // Pixel 2: low nibble of byte 1 = 0x0 → alpha 0x00.
        assert_eq!(rgba[11], 0x00);
    }

    /// Non-multiple-of-4 dimensions: trailing pixels of partial blocks
    /// must not write out-of-bounds.
    #[test]
    fn dxt1_3x3_doesnt_overrun() {
        let block: [u8; 8] = [0x00, 0xF8, 0x1F, 0x00, 0x00, 0x00, 0x00, 0x00];
        let rgba = decompress_dxt1(&block, 3, 3);
        assert_eq!(rgba.len(), 36); // 3×3×4
        // First pixel should be red.
        assert!(rgba[0] > 0xF0);
    }
}
