// bc7cli — PNG -> HBC7 v2 container (BC7, full mip chain).
//
// Rewrite of the lost scratchpad tool that produced the shipped
// /mnt/wbterminal2/pbr-terrain/bc7/blocks-mip payloads (see
// docs/HANDOFF-bc7-texture-unification-2026-07-30.md §3). The container
// contract is dictated by the client's parseHbc7
// (apps/holtburger-web/scene3d/bc7_textures.js) and enforced by
// validate_hbc7 (apps/holtburger-tools/src/dat_shard.rs):
//
//   magic "HBC7" | u32 width | u32 height | u32 blocksX | u32 blocksY
//   then levels appended contiguously, each ceil(w/4)*ceil(h/4)*16 bytes,
//   dims halving via max(1, n>>1) terminating at 1x1, every byte consumed.
//
// Mips are box-downsampled from the SOURCE image and each level encoded
// independently — never by decoding/re-encoding BC7.
//
// Build:  g++ -O2 -o bc7cli bc7cli.cpp bc7enc.cpp lodepng.cpp
// Usage:  bc7cli <in.png> <out.hbc7> [--no-mips] [--uber N]
#include "bc7enc.h"
#include "lodepng.h"
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>

// Box-downsample the level-0 RGBA image to exactly (dw, dh). Each dest texel
// averages the source rectangle that maps onto it (handles non-multiple and
// odd dims; alpha averaged like the colour channels, matching the shipped
// payloads' graded-alpha behaviour).
static std::vector<uint8_t> box_down(const std::vector<uint8_t> &src, uint32_t sw, uint32_t sh,
                                     uint32_t dw, uint32_t dh) {
    std::vector<uint8_t> out((size_t)dw * dh * 4);
    for (uint32_t y = 0; y < dh; y++) {
        uint32_t y0 = (uint32_t)((uint64_t)y * sh / dh);
        uint32_t y1 = (uint32_t)(((uint64_t)y + 1) * sh / dh);
        if (y1 <= y0) y1 = y0 + 1;
        for (uint32_t x = 0; x < dw; x++) {
            uint32_t x0 = (uint32_t)((uint64_t)x * sw / dw);
            uint32_t x1 = (uint32_t)(((uint64_t)x + 1) * sw / dw);
            if (x1 <= x0) x1 = x0 + 1;
            uint64_t acc[4] = {0, 0, 0, 0};
            for (uint32_t sy = y0; sy < y1; sy++)
                for (uint32_t sx = x0; sx < x1; sx++) {
                    const uint8_t *p = &src[((size_t)sy * sw + sx) * 4];
                    for (int c = 0; c < 4; c++) acc[c] += p[c];
                }
            uint64_t n = (uint64_t)(x1 - x0) * (y1 - y0);
            uint8_t *q = &out[((size_t)y * dw + x) * 4];
            for (int c = 0; c < 4; c++) q[c] = (uint8_t)((acc[c] + n / 2) / n);
        }
    }
    return out;
}

// Encode one level: 4x4 blocks with edge-replicate padding.
static void encode_level(const std::vector<uint8_t> &px, uint32_t w, uint32_t h,
                         const bc7enc_compress_block_params &params, std::vector<uint8_t> &out) {
    uint32_t bx = (w + 3) / 4, by = (h + 3) / 4;
    uint8_t block_px[16 * 4];
    uint8_t block[16];
    for (uint32_t byi = 0; byi < by; byi++) {
        for (uint32_t bxi = 0; bxi < bx; bxi++) {
            for (uint32_t py = 0; py < 4; py++) {
                uint32_t sy = byi * 4 + py;
                if (sy >= h) sy = h - 1;
                for (uint32_t pxi = 0; pxi < 4; pxi++) {
                    uint32_t sx = bxi * 4 + pxi;
                    if (sx >= w) sx = w - 1;
                    memcpy(&block_px[(py * 4 + pxi) * 4], &px[((size_t)sy * w + sx) * 4], 4);
                }
            }
            bc7enc_compress_block(block, block_px, &params);
            out.insert(out.end(), block, block + 16);
        }
    }
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: bc7cli <in.png> <out.hbc7> [--no-mips] [--uber N]\n");
        return 2;
    }
    bool mips = true;
    uint32_t uber = 4;
    for (int i = 3; i < argc; i++) {
        if (!strcmp(argv[i], "--no-mips")) mips = false;
        else if (!strcmp(argv[i], "--uber") && i + 1 < argc) uber = (uint32_t)atoi(argv[++i]);
    }

    std::vector<uint8_t> src;
    unsigned sw = 0, sh = 0;
    if (lodepng::decode(src, sw, sh, argv[1]) != 0) {
        fprintf(stderr, "bc7cli: cannot decode %s\n", argv[1]);
        return 1;
    }

    bc7enc_compress_block_init();
    bc7enc_compress_block_params params;
    bc7enc_compress_block_params_init(&params);
    params.m_uber_level = uber > BC7ENC_MAX_UBER_LEVEL ? BC7ENC_MAX_UBER_LEVEL : uber;

    std::vector<uint8_t> payload;
    payload.reserve((size_t)sw * sh * 2);
    const char magic[4] = {'H', 'B', 'C', '7'};
    payload.insert(payload.end(), magic, magic + 4);
    uint32_t hdr[4] = {sw, sh, (sw + 3) / 4, (sh + 3) / 4};
    payload.insert(payload.end(), (uint8_t *)hdr, (uint8_t *)hdr + 16);

    uint32_t w = sw, h = sh;
    for (;;) {
        std::vector<uint8_t> level =
            (w == sw && h == sh) ? src : box_down(src, sw, sh, w, h);
        encode_level(level, w, h, params, payload);
        if (!mips || (w == 1 && h == 1)) break;
        w = w > 1 ? w >> 1 : 1;
        h = h > 1 ? h >> 1 : 1;
    }

    FILE *f = fopen(argv[2], "wb");
    if (!f || fwrite(payload.data(), 1, payload.size(), f) != payload.size()) {
        fprintf(stderr, "bc7cli: cannot write %s\n", argv[2]);
        return 1;
    }
    fclose(f);
    printf("%s: %ux%u -> %zu bytes%s\n", argv[2], sw, sh, payload.size(), mips ? " (mipped)" : "");
    return 0;
}
