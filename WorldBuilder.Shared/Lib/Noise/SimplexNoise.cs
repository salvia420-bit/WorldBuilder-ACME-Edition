using System;
using System.Runtime.CompilerServices;

namespace WorldBuilder.Shared.Lib.Noise;

/// <summary>
/// Pure C# implementation of 2D Simplex noise.
/// Deterministic given the same seed — uses a seeded permutation table.
/// Performance target: 5.27M samples in under 2 seconds.
/// </summary>
public sealed class SimplexNoise {
    private readonly byte[] _perm;
    private readonly byte[] _perm12; // perm mod 12, pre-computed

    // Gradient vectors for 2D simplex noise (12 directions)
    private static readonly float[] Grad2X = { 1, -1,  1, -1,  1, -1,  1, -1,  0,  0,  0,  0 };
    private static readonly float[] Grad2Y = { 1,  1, -1, -1,  0,  0,  0,  0,  1, -1,  1, -1 };

    // Skewing factors for 2D
    private const float F2 = 0.3660254037844386f; // (sqrt(3) - 1) / 2
    private const float G2 = 0.21132486540518713f; // (3 - sqrt(3)) / 6

    public SimplexNoise(int seed) {
        _perm = new byte[512];
        _perm12 = new byte[512];

        // Build base permutation from seed using Fisher-Yates shuffle
        var source = new byte[256];
        for (int i = 0; i < 256; i++) source[i] = (byte)i;

        // Use a simple hash-based PRNG seeded by the input
        uint s = (uint)seed;
        for (int i = 255; i > 0; i--) {
            s = Hash(s);
            int j = (int)(s % (uint)(i + 1));
            (source[i], source[j]) = (source[j], source[i]);
        }

        for (int i = 0; i < 512; i++) {
            _perm[i] = source[i & 255];
            _perm12[i] = (byte)(_perm[i] % 12);
        }
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static uint Hash(uint x) {
        x ^= x >> 16;
        x *= 0x45D9F3B;
        x ^= x >> 16;
        x *= 0x45D9F3B;
        x ^= x >> 16;
        return x;
    }

    /// <summary>
    /// Evaluate 2D Simplex noise at (x, y). Returns a value in [-1, 1].
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public float Evaluate(float x, float y) {
        // Skew input space to determine which simplex cell we're in
        float s = (x + y) * F2;
        int i = FastFloor(x + s);
        int j = FastFloor(y + s);

        float t = (i + j) * G2;
        float X0 = i - t; // Unskew the cell origin back to (x, y) space
        float Y0 = j - t;
        float x0 = x - X0; // distances from the cell origin
        float y0 = y - Y0;

        // Determine which simplex we are in
        int i1, j1;
        if (x0 > y0) { i1 = 1; j1 = 0; } // lower triangle, XY order: (0,0)->(1,0)->(1,1)
        else { i1 = 0; j1 = 1; }          // upper triangle, YX order: (0,0)->(0,1)->(1,1)

        float x1 = x0 - i1 + G2;
        float y1 = y0 - j1 + G2;
        float x2 = x0 - 1f + 2f * G2;
        float y2 = y0 - 1f + 2f * G2;

        // Hash coordinates of the three simplex corners
        int ii = i & 255;
        int jj = j & 255;

        // Corner contributions
        float n0, n1, n2;

        float t0 = 0.5f - x0 * x0 - y0 * y0;
        if (t0 < 0f) n0 = 0f;
        else {
            int gi0 = _perm12[ii + _perm[jj]];
            t0 *= t0;
            n0 = t0 * t0 * (Grad2X[gi0] * x0 + Grad2Y[gi0] * y0);
        }

        float t1 = 0.5f - x1 * x1 - y1 * y1;
        if (t1 < 0f) n1 = 0f;
        else {
            int gi1 = _perm12[ii + i1 + _perm[jj + j1]];
            t1 *= t1;
            n1 = t1 * t1 * (Grad2X[gi1] * x1 + Grad2Y[gi1] * y1);
        }

        float t2 = 0.5f - x2 * x2 - y2 * y2;
        if (t2 < 0f) n2 = 0f;
        else {
            int gi2 = _perm12[ii + 1 + _perm[jj + 1]];
            t2 *= t2;
            n2 = t2 * t2 * (Grad2X[gi2] * x2 + Grad2Y[gi2] * y2);
        }

        // Scale result to [-1, 1]
        return 70f * (n0 + n1 + n2);
    }

    /// <summary>
    /// Fractal Brownian Motion — layers multiple octaves of simplex noise.
    /// Returns a value roughly in [-1, 1] (depending on octave count and persistence).
    /// </summary>
    /// <param name="x">X coordinate</param>
    /// <param name="y">Y coordinate</param>
    /// <param name="octaves">Number of noise layers</param>
    /// <param name="lacunarity">Frequency multiplier per octave (default 2.0)</param>
    /// <param name="persistence">Amplitude multiplier per octave (default 0.5)</param>
    /// <param name="frequency">Base frequency (default 1.0)</param>
    /// <returns>Noise value roughly in [-1, 1]</returns>
    public float FBm(float x, float y, int octaves = 6,
        float lacunarity = 2f, float persistence = 0.5f, float frequency = 1f) {

        float sum = 0f;
        float amplitude = 1f;
        float maxAmplitude = 0f;
        float freq = frequency;

        for (int o = 0; o < octaves; o++) {
            sum += amplitude * Evaluate(x * freq, y * freq);
            maxAmplitude += amplitude;
            amplitude *= persistence;
            freq *= lacunarity;
        }

        // Normalize to [-1, 1]
        return sum / maxAmplitude;
    }

    /// <summary>
    /// Upstream-compatible FBM signature (positional octaves + persistence/lacunarity).
    /// Equivalent to <see cref="FBm"/> with frequency=1.
    /// </summary>
    public float FBM(float x, float y, int octaves, float persistence = 0.5f, float lacunarity = 2.0f)
        => FBm(x, y, octaves, lacunarity, persistence, 1f);

    /// <summary>Ridged noise variant for mountain ranges. Returns [0, 1].</summary>
    public float RidgedNoise(float x, float y, int octaves, float persistence = 0.5f, float lacunarity = 2.0f) {
        float total = 0f;
        float amplitude = 1f;
        float frequency = 1f;
        float maxAmplitude = 0f;

        for (int i = 0; i < octaves; i++) {
            float n = 1f - MathF.Abs(Evaluate(x * frequency, y * frequency));
            total += n * n * amplitude;
            maxAmplitude += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }

        return total / maxAmplitude;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int FastFloor(float x) {
        int xi = (int)x;
        return x < xi ? xi - 1 : xi;
    }
}
