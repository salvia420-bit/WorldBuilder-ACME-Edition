/// Returns `true` if `candidate` is newer than `current` for a wrapping `u16` sequence.
///
/// Uses half-range ordering semantics: differences in `(0, 0x8000)` are considered forward,
/// and differences in `(0x8000, 0xFFFF]` are considered older. At exactly `delta == 0x8000`
/// the result is directional (`candidate < current`), matching retail `CPhysicsObj::is_newer`.
#[inline]
pub fn is_newer_u16(candidate: u16, current: u16) -> bool {
    // Retail-exact half-range ordering (acclient.c:143002-143013
    // CPhysicsObj::is_newer): `abs(new - old) > 0x7FFF` selects the
    // `new < old` branch, otherwise `old < new`. At exactly delta==0x8000
    // (abs > 0x7FFF) the result is therefore base-dependent (directional),
    // not unconditionally "not newer".
    let delta = candidate.wrapping_sub(current);
    delta != 0 && (delta < 0x8000 || (delta == 0x8000 && candidate < current))
}

/// Returns `true` if `candidate` is newer than `current` for a wrapping `u32` sequence.
///
/// Uses half-range ordering semantics: differences in `(0, 0x8000_0000)` are considered forward,
/// and differences in `[0x8000_0000, 0xFFFF_FFFF]` are considered older/ambiguous.
#[inline]
pub fn is_newer_u32(candidate: u32, current: u32) -> bool {
    let delta = candidate.wrapping_sub(current);
    delta != 0 && delta < 0x8000_0000
}

#[cfg(test)]
mod tests {
    use super::{is_newer_u16, is_newer_u32};

    #[test]
    fn u16_basic_ordering() {
        assert!(is_newer_u16(11, 10));
        assert!(!is_newer_u16(10, 10));
        assert!(!is_newer_u16(10, 11));
    }

    #[test]
    fn u16_wrap_ordering() {
        assert!(is_newer_u16(0, u16::MAX));
        assert!(is_newer_u16(1, u16::MAX));
        assert!(!is_newer_u16(u16::MAX, 0));
    }

    #[test]
    fn u16_half_range_is_directional() {
        // Retail boundary (acclient.c:143002-143013): at exactly delta==0x8000
        // (abs(new-old) > 0x7FFF) the result is `candidate < current`.
        assert!(is_newer_u16(0, 0x8000));
        assert!(!is_newer_u16(0x8000, 0));
    }

    /// WS07 (2026-07-12, F11) — the exact windup-dedup invariant for remote
    /// casters: three windups carrying INCREASING stamps (outcome (a), the
    /// SAFE non-PK path) each pass `is_newer`, so all three render; a REPEATED
    /// stamp (outcome (b), the disfavored drop path) is rejected. This pins the
    /// behavior our `MOTION_ACTION_STAMPS` / JS `_actionStamps` dedup relies on.
    #[test]
    fn three_increasing_stamps_all_pass_then_a_repeat_is_dropped() {
        let (n0, n1, n2) = (40u16, 41u16, 42u16);
        assert!(is_newer_u16(n1, n0), "windup 2 (seq N+1) is newer than windup 1");
        assert!(is_newer_u16(n2, n1), "windup 3 (seq N+2) is newer than windup 2");
        assert!(
            !is_newer_u16(n2, n2),
            "a repeated stamp (outcome b) is NOT newer → the windup is dropped"
        );
    }

    #[test]
    fn u32_basic_ordering() {
        assert!(is_newer_u32(11, 10));
        assert!(!is_newer_u32(10, 10));
        assert!(!is_newer_u32(10, 11));
    }

    #[test]
    fn u32_wrap_ordering() {
        assert!(is_newer_u32(0, u32::MAX));
        assert!(is_newer_u32(1, u32::MAX));
        assert!(!is_newer_u32(u32::MAX, 0));
    }

    #[test]
    fn u32_half_range_is_not_newer() {
        assert!(!is_newer_u32(0x8000_0000, 0));
        assert!(!is_newer_u32(0, 0x8000_0000));
    }
}
