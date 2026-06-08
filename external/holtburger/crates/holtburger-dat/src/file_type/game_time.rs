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

use crate::file_type::region::write_pstring_char;
use crate::utils::read_pstring_char;
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};

/// Realm-level wall-clock descriptor. The retail `GameTime` table seeds AC's
/// time-of-day system + the skybox's deterministic day-group selector.
#[derive(Debug, Clone, serde::Serialize)]
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct TimeOfDay {
    /// Hour-of-day start (in AC's normalized 0.0..1.0 day fraction).
    pub start: f32,
    pub is_night: bool,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
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

        let year_spec = read_pstring_char(reader)?;

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
            let name = read_pstring_char(reader)?;
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

    /// Reverse of [`GameTime::unpack`] — emits the wire layout in the exact
    /// field order the parser reads: `f64 zero_time_of_year`, `u32 zero_year`,
    /// `f32 day_length`, `u32 days_per_year`, `year_spec` (PStringBase<char>,
    /// 4-aligned), `u32 num_times_of_day` + that many [`TimeOfDay`], `u32
    /// num_days_of_week` + that many bare aligned PStrings, `u32 num_seasons`
    /// + that many [`Season`]. Mirrors `dats.xml:2780-2806`.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.zero_time_of_year.to_le_bytes());
        out.extend_from_slice(&self.zero_year.to_le_bytes());
        out.extend_from_slice(&self.day_length.to_le_bytes());
        out.extend_from_slice(&self.days_per_year.to_le_bytes());

        write_pstring_char(out, &self.year_spec);

        out.extend_from_slice(&(self.times_of_day.len() as u32).to_le_bytes());
        for tod in &self.times_of_day {
            tod.pack(out);
        }

        out.extend_from_slice(&(self.days_of_week.len() as u32).to_le_bytes());
        for name in &self.days_of_week {
            // dats.xml:2790-2792 — bare AC1LegacyPStringBase, same align-to-4.
            write_pstring_char(out, name);
        }

        out.extend_from_slice(&(self.seasons.len() as u32).to_le_bytes());
        for s in &self.seasons {
            s.pack(out);
        }
    }
}

impl TimeOfDay {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let start = f32::read_le(reader)?;
        // dats.xml:2798 — `bool size="4"`. AC writes the bool as a 4-byte uint.
        let is_night_raw = u32::read_le(reader)?;
        let is_night = is_night_raw != 0;
        let name = read_pstring_char(reader)?;
        Ok(TimeOfDay {
            start,
            is_night,
            name,
        })
    }

    /// Reverse of [`TimeOfDay::unpack`] — `f32 start`, the 4-byte bool
    /// `is_night` (dats.xml:2798 `bool size="4"`, written as `1u32`/`0u32`),
    /// then the 4-aligned PStringBase<char> `name`.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.start.to_le_bytes());
        out.extend_from_slice(&(self.is_night as u32).to_le_bytes());
        write_pstring_char(out, &self.name);
    }
}

impl Season {
    pub fn unpack<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let start = u32::read_le(reader)?;
        let name = read_pstring_char(reader)?;
        Ok(Season { start, name })
    }

    /// Reverse of [`Season::unpack`] — `u32 start` then the 4-aligned
    /// PStringBase<char> `name`.
    pub fn pack(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.start.to_le_bytes());
        write_pstring_char(out, &self.name);
    }
}
