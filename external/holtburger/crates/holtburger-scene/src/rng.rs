//! Explicit random streams for the kernels.
//!
//! JS draws from `Math.random()` (via hooks such as
//! scene3d/particles/time_rng.js `rng()`). A Rust kernel never reaches for a
//! global: it is handed an [`Rng`]. Production uses [`Rng::seeded`]; parity
//! tests use [`Rng::scripted`] with the exact values the JS reference drew, so
//! a port that draws in a different ORDER fails the test even when its
//! distribution is right.

/// A uniform `[0, 1)` source.
#[derive(Clone, Debug)]
pub enum Rng {
    /// SplitMix64. Fast, good enough for visual randomness, deterministic.
    Seeded { state: u64 },
    /// Replays `values` in order. Past the end it returns 0.5 and sets
    /// `overrun`, which a parity test asserts is false.
    Scripted {
        values: Vec<f64>,
        pos: usize,
        overrun: bool,
    },
}

impl Rng {
    pub fn seeded(seed: u64) -> Rng {
        Rng::Seeded { state: seed }
    }

    pub fn scripted(values: Vec<f64>) -> Rng {
        Rng::Scripted { values, pos: 0, overrun: false }
    }

    /// Next value in `[0, 1)`, the role of `Math.random()`.
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        match self {
            Rng::Seeded { state } => {
                *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = *state;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^= z >> 31;
                // 53 random bits → [0, 1).
                (z >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
            }
            Rng::Scripted { values, pos, overrun } => {
                if *pos < values.len() {
                    let v = values[*pos];
                    *pos += 1;
                    v
                } else {
                    *overrun = true;
                    0.5
                }
            }
        }
    }

    /// Values consumed so far (scripted) — lets a test check the port drew
    /// exactly as many values as the JS reference.
    pub fn consumed(&self) -> Option<usize> {
        match self {
            Rng::Scripted { pos, .. } => Some(*pos),
            Rng::Seeded { .. } => None,
        }
    }

    pub fn overrun(&self) -> bool {
        matches!(self, Rng::Scripted { overrun: true, .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_in_range_and_deterministic() {
        let mut a = Rng::seeded(42);
        let mut b = Rng::seeded(42);
        for _ in 0..10_000 {
            let v = a.next_f64();
            assert!((0.0..1.0).contains(&v));
            assert_eq!(v, b.next_f64());
        }
    }

    #[test]
    fn scripted_replays_then_flags_overrun() {
        let mut r = Rng::scripted(vec![0.25, 0.75]);
        assert_eq!(r.next_f64(), 0.25);
        assert_eq!(r.next_f64(), 0.75);
        assert!(!r.overrun());
        assert_eq!(r.next_f64(), 0.5);
        assert!(r.overrun());
        assert_eq!(r.consumed(), Some(2));
    }
}
