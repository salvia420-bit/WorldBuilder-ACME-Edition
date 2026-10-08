use std::collections::HashSet;

#[allow(dead_code)]
pub struct Hash32;

#[allow(dead_code)]
impl Hash32 {
    pub fn compute(data: &[u8]) -> u32 {
        let length = data.len();
        let mut checksum: u32 = (length as u32) << 16;
        let mut i = 0;

        while i + 4 <= length {
            let chunk = u32::from_le_bytes(data[i..i + 4].try_into().unwrap());
            checksum = checksum.wrapping_add(chunk);
            i += 4;
        }

        let mut shift = 3;
        while i < length {
            checksum = checksum.wrapping_add((data[i] as u32) << (8 * shift));
            i += 1;
            shift -= 1;
        }

        checksum
    }
}

pub struct Isaac {
    offset: usize,
    a: u32,
    b: u32,
    c: u32,
    mm: [u32; 256],
    rand_rsl: [u32; 256],
    xors: HashSet<u32>,
    pub current_key: u32,
}

impl Isaac {
    /// How many keystream words [`Isaac::search`] may walk ahead of the last
    /// consumed key (and the ceiling on the out-of-order key set `xors`).
    ///
    /// net-3 (R2-net 2026-10-08): was 256, so a burst of more than 256 lost
    /// server packets (bridge kernel drops while a browser reader stalled)
    /// put the S2C keystream permanently out of reach: every later encrypted
    /// packet failed its checksum silently and nothing was ever NAKed. Retail
    /// has no such cliff: it parks one key per missing sequence
    /// (`ReceiverData::AddNakked`, acclient.c:376642) and only drops packets
    /// more than 0x7FFF past the highest id (`SharedNet::SeqIDSanityCheck`,
    /// acclient.c:371343). 4096 is the mitigation (the full per-sequence key
    /// park is a separate change); a duplicate or forged packet now walks at
    /// most 4096 words. `holtburger-session` sizes its S2C reorder window
    /// from this constant, so keep them coupled.
    pub const MAXIMUM_EFFORT_LEVEL: usize = 4096;

    pub fn new(seed: u32) -> Self {
        let mut isaac = Isaac {
            offset: 255,
            a: 0,
            b: 0,
            c: 0,
            mm: [0; 256],
            rand_rsl: [0; 256],
            xors: HashSet::new(),
            current_key: 0,
        };
        isaac.initialize(seed);
        // ACE/CryptoSystem consumes the first word immediately upon initialization.
        isaac.current_key = isaac.next();
        isaac
    }

    pub fn consume_key(&mut self) {
        self.current_key = self.next();
    }

    pub fn consume_key_value(&mut self, key: u32) {
        if self.current_key == key {
            self.current_key = self.next();
        } else {
            self.xors.remove(&key);
        }
    }

    pub fn search(&mut self, key: u32) -> bool {
        if self.current_key == key {
            return true;
        }

        if self.xors.contains(&key) {
            return true;
        }

        let effort_level = Self::MAXIMUM_EFFORT_LEVEL.saturating_sub(self.xors.len());
        for _ in 0..effort_level {
            self.xors.insert(self.current_key);
            self.consume_key();

            if self.current_key == key {
                return true;
            }
        }

        false
    }

    #[allow(clippy::should_implement_trait)]
    fn next(&mut self) -> u32 {
        let val = self.rand_rsl[self.offset];
        if self.offset > 0 {
            self.offset -= 1;
        } else {
            self.scramble();
            self.offset = 255;
        }
        val
    }

    fn initialize(&mut self, seed: u32) {
        let mut abcdefgh = [0x9E3779B9u32; 8];

        for _ in 0..4 {
            Self::shuffle(&mut abcdefgh);
        }

        for i in 0..2 {
            for j in (0..256).step_by(8) {
                for (k, val) in abcdefgh.iter_mut().enumerate() {
                    if i < 1 {
                        *val = val.wrapping_add(self.rand_rsl[j + k]);
                    } else {
                        *val = val.wrapping_add(self.mm[j + k]);
                    }
                }

                Self::shuffle(&mut abcdefgh);

                self.mm[j..j + 8].copy_from_slice(&abcdefgh);
            }
        }

        // ACE specific: a, b, c set to seed, then scramble immediately
        self.a = seed;
        self.b = seed;
        self.c = seed;

        self.scramble();
    }

    fn shuffle(r: &mut [u32; 8]) {
        r[0] ^= r[1] << 11;
        r[3] = r[3].wrapping_add(r[0]);
        r[1] = r[1].wrapping_add(r[2]);
        r[1] ^= r[2] >> 2;
        r[4] = r[4].wrapping_add(r[1]);
        r[2] = r[2].wrapping_add(r[3]);
        r[2] ^= r[3] << 8;
        r[5] = r[5].wrapping_add(r[2]);
        r[3] = r[3].wrapping_add(r[4]);
        r[3] ^= r[4] >> 16;
        r[6] = r[6].wrapping_add(r[3]);
        r[4] = r[4].wrapping_add(r[5]);
        r[4] ^= r[5] << 10;
        r[7] = r[7].wrapping_add(r[4]);
        r[5] = r[5].wrapping_add(r[6]);
        r[5] ^= r[6] >> 4;
        r[0] = r[0].wrapping_add(r[5]);
        r[6] = r[6].wrapping_add(r[7]);
        r[6] ^= r[7] << 8;
        r[1] = r[1].wrapping_add(r[6]);
        r[7] = r[7].wrapping_add(r[0]);
        r[7] ^= r[0] >> 9;
        r[2] = r[2].wrapping_add(r[7]);
        r[0] = r[0].wrapping_add(r[1]);
    }

    fn scramble(&mut self) {
        self.c = self.c.wrapping_add(1);
        self.b = self.b.wrapping_add(self.c);

        for i in 0..256 {
            let x = self.mm[i];
            match i & 3 {
                0 => self.a ^= self.a << 13,
                1 => self.a ^= self.a >> 6,
                2 => self.a ^= self.a << 2,
                3 => self.a ^= self.a >> 16,
                _ => unreachable!(),
            }
            self.a = self.a.wrapping_add(self.mm[i.wrapping_add(128) & 0xFF]);
            let y = self.mm[((x >> 2) & 0xFF) as usize]
                .wrapping_add(self.a)
                .wrapping_add(self.b);
            self.mm[i] = y;
            self.b = self.mm[((y >> 10) & 0xFF) as usize].wrapping_add(x);
            self.rand_rsl[i] = self.b;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash32_simple() {
        let data = b"hello world";
        let hash = Hash32::compute(data);
        assert_ne!(hash, 0);
    }

    #[test]
    fn test_hash32_tail_padding() {
        // Test with different lengths to hit different tail scenarios
        let d1 = b"abc";
        let d2 = b"abcd";
        let d3 = b"abcde";

        assert_ne!(Hash32::compute(d1), Hash32::compute(d2));
        assert_ne!(Hash32::compute(d2), Hash32::compute(d3));
    }

    #[test]
    fn test_isaac_init() {
        let mut isaac = Isaac::new(0x12345678);
        let first = isaac.next();
        let second = isaac.next();
        assert_ne!(first, second);
    }

    #[test]
    fn test_isaac_search_handles_out_of_order_keys() {
        let seed = 0xC83824AB;

        let mut expected = Isaac::new(seed);
        let first = expected.current_key;
        expected.consume_key();
        let second = expected.current_key;
        expected.consume_key();
        let third = expected.current_key;

        let mut actual = Isaac::new(seed);
        assert!(actual.search(second));
        actual.consume_key_value(second);
        assert_eq!(actual.current_key, third);

        assert!(actual.search(first));
        actual.consume_key_value(first);
        assert_eq!(actual.current_key, third);
    }

    /// net-3 (R2-net 2026-10-08): a burst of 299 lost packets (beyond the old
    /// 256-word cliff) is still recoverable, the skipped keys validate when
    /// the retransmissions arrive, and a second burst after that is found too.
    #[test]
    fn search_recovers_gap_larger_than_256() {
        let seed = 0xC83824AB;
        let mut shadow = Isaac::new(seed);
        let mut burst = Vec::with_capacity(300);
        for _ in 0..300 {
            burst.push(shadow.current_key);
            shadow.consume_key();
        }

        let mut actual = Isaac::new(seed);
        // Packets 0..299 lost; packet 299 arrives first.
        assert!(actual.search(burst[299]));
        actual.consume_key_value(burst[299]);

        // The retransmissions of 0..299 arrive late and still validate.
        for &key in &burst[..299] {
            assert!(actual.search(key));
            actual.consume_key_value(key);
        }

        // A second 299-packet burst is found as well.
        let mut second = Vec::with_capacity(300);
        for _ in 0..300 {
            second.push(shadow.current_key);
            shadow.consume_key();
        }
        assert!(actual.search(second[299]));
        actual.consume_key_value(second[299]);
        assert_eq!(actual.current_key, shadow.current_key);
    }

    /// net-3: the walk reaches exactly `MAXIMUM_EFFORT_LEVEL` words past the
    /// current key and no further.
    #[test]
    fn search_reach_is_bounded_by_effort_level() {
        let seed = 0xDEADBEEF;
        let mut shadow = Isaac::new(seed);
        let mut words = Vec::with_capacity(Isaac::MAXIMUM_EFFORT_LEVEL + 2);
        for _ in 0..Isaac::MAXIMUM_EFFORT_LEVEL + 2 {
            words.push(shadow.current_key);
            shadow.consume_key();
        }

        let mut at_limit = Isaac::new(seed);
        assert!(at_limit.search(words[Isaac::MAXIMUM_EFFORT_LEVEL]));

        let mut past_limit = Isaac::new(seed);
        assert!(!past_limit.search(words[Isaac::MAXIMUM_EFFORT_LEVEL + 1]));
    }

    #[test]
    fn test_golden_vectors() {
        // Test Hash32
        assert_eq!(Hash32::compute(b"hello world"), 0x4E5AE9D7);
        assert_eq!(Hash32::compute(&[0xC8, 0xF7, 0x00, 0x00]), 0x0004F7C8);
        assert_eq!(Hash32::compute(b"A"), 0x41010000);
        assert_eq!(Hash32::compute(b"AB"), 0x41440000);
        assert_eq!(Hash32::compute(b"ABC"), 0x41454300);
        assert_eq!(Hash32::compute(b"ABCD"), 0x44474241);
        assert_eq!(Hash32::compute(b"ABCDE"), 0x89484241);
        assert_eq!(Hash32::compute(&[0x01, 0x02, 0x03, 0x04, 0x05]), 0x09080201);

        // Test ISAAC (Seed 0x99E77855 from logs)
        let mut isaac = Isaac::new(0x99E77855);
        assert_eq!(isaac.current_key, 0xAD497DF3);
        isaac.consume_key();
        assert_eq!(isaac.current_key, 0x70FAAA14);

        // Test ISAAC (Seed 0xC83824AB from temp_isaac.rs)
        let mut s2c = Isaac::new(0xC83824AB);
        assert_eq!(s2c.current_key, 0x1518CF56);
        s2c.consume_key();
        assert_eq!(s2c.current_key, 0x5F2E0E56);
        s2c.consume_key();
        assert_eq!(s2c.current_key, 0x73D586BF);

        // Test ISAAC (Seed 0xFBD52C87 from temp_isaac.rs)
        let mut c2s = Isaac::new(0xFBD52C87);
        assert_eq!(c2s.current_key, 0x9FF3700A);
        c2s.consume_key();
        assert_eq!(c2s.current_key, 0x4C4423E8);

        // Test ISAAC (Seed 0xDEADBEEF)
        let mut dead = Isaac::new(0xDEADBEEF);
        assert_eq!(dead.current_key, 0x5DA22D96);
        dead.consume_key();
        assert_eq!(dead.current_key, 0xDB3BA3B6);
        dead.consume_key();
        assert_eq!(dead.current_key, 0x9FD967F9);

        // Test ISAAC (Seed 0x0)
        let mut zero = Isaac::new(0x0);
        assert_eq!(zero.current_key, 0x182600F3);
        zero.consume_key();
        assert_eq!(zero.current_key, 0x300B4A8D);
    }
}
