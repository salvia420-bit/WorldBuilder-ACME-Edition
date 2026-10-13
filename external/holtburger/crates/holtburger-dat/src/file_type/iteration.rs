//! AC Iteration (file ID `0xFFFF0001`) — the DAT "versioning" record.
//! Stored in `client_cell.dat`, `client_portal.dat`, and
//! `client_local_English.dat` at the well-known index `0xFFFF0001`.
//! Used during connect to compare client vs. server DAT iteration so the
//! client knows what (if anything) needs patching.
//!
//! The record body is a serialized `CMostlyConsecutiveIntSet`: the set of
//! patch iterations applied to this DAT. `DiskController::LoadIterationList`
//! hands the record to `CMostlyConsecutiveIntSet::Serialize` (acclient.c,
//! unpack branch):
//! ```text
//! [u32 count]                  // iterations in the set; > 100000 is an error
//! then entries until `count` iterations are filled:
//!   [i32 v >= 0]               // one iteration (bit 30 set => v |= 0x80000000)
//!   [i32 v <  0] [i32 start]   // a run of -v consecutive iterations from start
//! ```
//! A run that would overfill `count` is an error. There is no `sorted`
//! byte and no alignment pad: retail sets `m_bSorted = 1` in memory after
//! unpacking. ACE (`ACE.DatLoader/FileTypes/Iteration.cs`) reads the same
//! record as `TotalIterations` + `(consecutive, start)` pairs, i.e. only
//! the run form. Retail's packer writes stretches of one or two iterations
//! as single values, so a packed run entry is 3 or more long. Every retail EoR
//! DAT holds one run: portal `[2072][-2072][1]`, cell `[982][-982][1]`,
//! local `[994][-994][1]`.
//!
//! Note there is no leading `id` field in the record body — the file ID
//! is the directory index. Read-only; no write path.

use binrw::{BinRead, BinResult};
use std::io::{Read, Seek};

/// Well-known DAT directory index for the Iteration record.
pub const FILE_ID: u32 = 0xFFFF_0001;

/// Largest `count` retail accepts (`0x186A0`, acclient.c
/// `CMostlyConsecutiveIntSet::Serialize`); anything above raises an error.
pub const MAX_COUNT: u32 = 100_000;

/// One encoded entry of the set: `len` consecutive iterations starting at
/// `start`. A single-value entry decodes as `len == 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct IterationRun {
    pub start: i32,
    pub len: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Iteration {
    /// Leading count: how many iterations the set holds (retail
    /// `m_Ints.m_num`, ACE `TotalIterations`).
    pub total: u32,
    /// The encoded entries in file order. Their lengths sum to `total`.
    pub runs: Vec<IterationRun>,
}

impl Iteration {
    pub const FILE_ID: u32 = FILE_ID;

    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Self::read_internal(reader)
    }

    pub fn unpack(data: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(data);
        Self::read_internal(&mut cursor)
    }

    /// The DAT's iteration as ACE `DatDatabase.GetTotalIterations` reports
    /// it: the leading count, whether or not the set is one run.
    pub fn total_iterations(&self) -> u32 {
        self.total
    }

    /// A fully patched DAT holds exactly one run. ACE logs "contains an
    /// incomplete dat file" when its `Ints` map has more than one entry.
    /// (A set of only one or two iterations packs as single values, so a
    /// two-iteration set reads as two entries here; no real DAT is that
    /// small.)
    pub fn is_complete(&self) -> bool {
        self.runs.len() == 1
    }

    /// The set expanded in file order, as retail fills `m_Ints`.
    pub fn ints(&self) -> Vec<i32> {
        let mut out = Vec::with_capacity(self.total as usize);
        for run in &self.runs {
            let mut v = run.start;
            for _ in 0..run.len {
                out.push(v);
                v = v.wrapping_add(1);
            }
        }
        out
    }

    fn read_internal<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let total = u32::read_le(reader)?;
        if total > MAX_COUNT {
            return Err(binrw::Error::Custom {
                pos: reader.stream_position().unwrap_or(0),
                err: Box::new(format!("Iteration count {total} exceeds retail cap {MAX_COUNT}")),
            });
        }
        let mut runs = Vec::new();
        let mut filled: u32 = 0;
        while filled < total {
            let v = i32::read_le(reader)?;
            if v >= 0 {
                // Retail packs single values as `v & 0x7FFFFFFF`; bit 30
                // carries the sign back.
                let v = if v & 0x4000_0000 != 0 {
                    (v as u32 | 0x8000_0000) as i32
                } else {
                    v
                };
                runs.push(IterationRun { start: v, len: 1 });
                filled += 1;
                continue;
            }
            let start = i32::read_le(reader)?;
            // `-v` wraps for i32::MIN; retail fills nothing for it.
            let len = v.wrapping_neg();
            if len <= 0 {
                continue;
            }
            let len = len as u32;
            if len > total - filled {
                return Err(binrw::Error::Custom {
                    pos: reader.stream_position().unwrap_or(0),
                    err: Box::new(format!(
                        "Iteration run of {len} from {start} overfills count {total} \
                         ({filled} already filled)"
                    )),
                });
            }
            runs.push(IterationRun { start, len });
            filled += len;
        }
        Ok(Self { total, runs })
    }
}

impl BinRead for Iteration {
    type Args<'a> = ();

    fn read_options<R: Read + Seek>(
        reader: &mut R,
        _endian: binrw::Endian,
        _args: Self::Args<'_>,
    ) -> BinResult<Self> {
        Self::read_internal(reader)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Little-endian i32 words, as the record stores them.
    fn words(ws: &[i32]) -> Vec<u8> {
        ws.iter().flat_map(|w| w.to_le_bytes()).collect()
    }

    #[test]
    fn complete_dat_is_one_run() {
        // Retail EoR client_portal.dat: [2072][-2072][1].
        let it = Iteration::unpack(&words(&[2072, -2072, 1])).unwrap();
        assert_eq!(it.total, 2072);
        assert_eq!(it.total_iterations(), 2072);
        assert_eq!(it.runs, vec![IterationRun { start: 1, len: 2072 }]);
        assert!(it.is_complete());
        let ints = it.ints();
        assert_eq!(ints.len(), 2072);
        assert_eq!(ints.first(), Some(&1));
        assert_eq!(ints.last(), Some(&2072));
    }

    #[test]
    fn split_ranges_are_incomplete() {
        // A partially patched DAT: 1..=4 and 6..=11.
        let it = Iteration::unpack(&words(&[10, -4, 1, -6, 6])).unwrap();
        assert_eq!(it.total_iterations(), 10);
        assert_eq!(
            it.runs,
            vec![
                IterationRun { start: 1, len: 4 },
                IterationRun { start: 6, len: 6 },
            ]
        );
        assert!(!it.is_complete());
        assert_eq!(it.ints(), vec![1, 2, 3, 4, 6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn single_values_mix_with_runs() {
        // A non-negative entry is one iteration with no start word.
        let it = Iteration::unpack(&words(&[3, 5, -2, 7])).unwrap();
        assert_eq!(it.ints(), vec![5, 7, 8]);
        assert_eq!(
            it.runs,
            vec![
                IterationRun { start: 5, len: 1 },
                IterationRun { start: 7, len: 2 },
            ]
        );
        assert!(!it.is_complete());
    }

    #[test]
    fn single_value_bit30_restores_sign() {
        // Retail packs -5 as `-5 & 0x7FFFFFFF` = 0x7FFFFFFB.
        let it = Iteration::unpack(&words(&[1, 0x7FFF_FFFB])).unwrap();
        assert_eq!(it.ints(), vec![-5]);
    }

    #[test]
    fn min_length_word_fills_nothing() {
        // -i32::MIN wraps to i32::MIN, so retail reads the start word and
        // fills nothing for that entry.
        let it = Iteration::unpack(&words(&[1, i32::MIN, 9, 4])).unwrap();
        assert_eq!(it.ints(), vec![4]);
        assert!(it.is_complete());
    }

    #[test]
    fn count_over_retail_cap_is_an_error() {
        let max = MAX_COUNT as i32;
        assert!(Iteration::unpack(&words(&[max, -max, 1])).is_ok());
        assert!(Iteration::unpack(&words(&[max + 1, -(max + 1), 1])).is_err());
    }

    #[test]
    fn run_overfilling_count_is_an_error() {
        assert!(Iteration::unpack(&words(&[3, -4, 1])).is_err());
    }

    #[test]
    fn truncated_record_is_an_error() {
        assert!(Iteration::unpack(&words(&[10, -4])).is_err());
        assert!(Iteration::unpack(&words(&[10, -4, 1])).is_err());
    }

    #[test]
    fn empty_set_reads_only_the_count() {
        let mut buf = words(&[0]);
        buf.extend_from_slice(&0xDEADBEEFu32.to_le_bytes());
        let mut cursor = std::io::Cursor::new(&buf);
        let it = Iteration::read(&mut cursor).unwrap();
        assert_eq!(it.total_iterations(), 0);
        assert!(it.runs.is_empty());
        assert!(!it.is_complete());
        assert_eq!(cursor.position(), 4);
    }

    #[test]
    fn trailing_sentinel_is_not_consumed() {
        let mut buf = words(&[2072, -2072, 1]);
        buf.extend_from_slice(&0xDEADBEEFu32.to_le_bytes());
        let mut cursor = std::io::Cursor::new(&buf);
        let it = Iteration::read(&mut cursor).unwrap();
        assert!(it.is_complete());
        // No `sorted` byte or alignment pad follows the entries.
        assert_eq!(cursor.position(), 12);
        assert_eq!(u32::read_le(&mut cursor).unwrap(), 0xDEADBEEF);
    }

    /// The retail base DATs each hold one complete run that starts at
    /// iteration 1, and the parser consumes the whole record. Run with
    /// `cargo test -p holtburger-dat --lib iteration -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn retail_dats_hold_one_complete_run() {
        use crate::DatDatabase;
        let base = std::path::PathBuf::from("/home/wbterminal/ac_base_dats");
        for name in [
            "client_portal.dat",
            "client_cell_1.dat",
            "client_local_English.dat",
        ] {
            let path = base.join(name);
            if !path.exists() {
                eprintln!("[iteration] SKIP {name}: not found");
                continue;
            }
            let dat = DatDatabase::new(&path).expect("open dat");
            let bytes = dat.get_file(FILE_ID).expect("Iteration record present");
            let mut cursor = std::io::Cursor::new(&bytes);
            let it = Iteration::read(&mut cursor)
                .unwrap_or_else(|e| panic!("{name}: Iteration parse failed: {e:?}"));
            eprintln!(
                "[iteration] {name}: total={} runs={:?}",
                it.total_iterations(),
                it.runs
            );
            assert!(it.total_iterations() > 0, "{name}: empty iteration set");
            assert!(it.is_complete(), "{name}: more than one run");
            assert_eq!(it.runs[0].start, 1, "{name}: run does not start at 1");
            assert_eq!(it.runs[0].len, it.total, "{name}: run length != count");
            assert_eq!(
                cursor.position(),
                bytes.len() as u64,
                "{name}: record not fully consumed"
            );
        }
    }
}
