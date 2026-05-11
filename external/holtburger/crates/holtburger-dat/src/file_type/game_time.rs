//! GameTime DBObj sub-record from `client_portal.dat` Region 0x1300xxxx.
//!
//! Schema reference: `external/DatReaderWriter/DatReaderWriter/dats.xml:2780-2806`.
//! Mirrors the AC1 client `GameTime` struct — drives the in-world clock that
//! the `SkyDesc::CalcPresentDayGroup` LCG hash (Workstream B) uses to pick the
//! active DayGroup each tick.
//!
//! All `AC1LegacyPStringBase` strings carry a `<align type="uint"/>` marker in
//! the schema — i.e. the cursor pads to a 4-byte boundary after the string body.
//! We mirror `BinaryReader::ReadString` from `external/GDL/PhatSDK/Support/`
//! `BinaryReader.cpp:48-73` which reads `WORD len; bytes; ReadAlign();`.

use crate::utils::{align_boundary, read_pstring};
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};

/// Realm-level wall-clock descriptor. The retail `GameTime` table seeds AC's
/// time-of-day system + the skybox's deterministic day-group selector.
#[derive(Debug, Clone)]
pub struct GameTime {
    /// Reference epoch — the *world* time (in seconds since some AC zero)
    /// that `ZeroYear` started at. PhatSDK reads this as `long double` but
    /// the on-wire bytes are an IEEE 754 binary64 (`double`).
    pub zero_time_of_year: f64,
    pub zero_year: u32,
    /// Length of one in-world day in real-time seconds.
    pub day_length: f32,
    pub days_per_year: u32,
    pub year_spec: String,
    pub times_of_day: Vec<TimeOfDay>,
    pub days_of_week: Vec<String>,
    pub seasons: Vec<Season>,
}

#[derive(Debug, Clone)]
pub struct TimeOfDay {
    /// Hour-of-day start (in AC's normalized 0.0..1.0 day fraction).
    pub start: f32,
    pub is_night: bool,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct Season {
    /// Day-of-year start (uint, not normalized).
    pub start: u32,
    pub name: String,
}

impl GameTime {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let zero_time_of_year = f64::read_le(reader)?;
        let zero_year = u32::read_le(reader)?;
        let day_length = f32::read_le(reader)?;
        let days_per_year = u32::read_le(reader)?;

        let year_spec = read_pstring(reader, 2)?;
        align_boundary(reader, 4)?;

        let num_times_of_day = u32::read_le(reader)?;
        let mut times_of_day = Vec::with_capacity(num_times_of_day as usize);
        for _ in 0..num_times_of_day {
            times_of_day.push(TimeOfDay::unpack(reader)?);
        }

        let num_days_of_week = u32::read_le(reader)?;
        let mut days_of_week = Vec::with_capacity(num_days_of_week as usize);
        for _ in 0..num_days_of_week {
            // dats.xml:2790-2792 — each entry is a bare AC1LegacyPStringBase
            // (no Season-style wrapping). Same align-to-4 contract applies.
            let name = read_pstring(reader, 2)?;
            align_boundary(reader, 4)?;
            days_of_week.push(name);
        }

        let num_seasons = u32::read_le(reader)?;
        let mut seasons = Vec::with_capacity(num_seasons as usize);
        for _ in 0..num_seasons {
            seasons.push(Season::unpack(reader)?);
        }

        Ok(GameTime {
            zero_time_of_year,
            zero_year,
            day_length,
            days_per_year,
            year_spec,
            times_of_day,
            days_of_week,
            seasons,
        })
    }
}

impl TimeOfDay {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let start = f32::read_le(reader)?;
        // dats.xml:2798 — `bool size="4"`. AC writes the bool as a 4-byte uint.
        let is_night_raw = u32::read_le(reader)?;
        let is_night = is_night_raw != 0;
        let name = read_pstring(reader, 2)?;
        align_boundary(reader, 4)?;
        Ok(TimeOfDay {
            start,
            is_night,
            name,
        })
    }
}

impl Season {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let start = u32::read_le(reader)?;
        let name = read_pstring(reader, 2)?;
        align_boundary(reader, 4)?;
        Ok(Season { start, name })
    }
}
