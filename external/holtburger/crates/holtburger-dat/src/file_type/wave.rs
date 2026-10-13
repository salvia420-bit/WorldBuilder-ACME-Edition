//! AC Wave (DatFileType `0x0A`) — raw audio sample data. Each
//! 0x0A000000–0x0A00FFFF record carries a `(header, data)` pair:
//! the header is a Windows-style `WAVEFORMATEX` blob and the data is
//! the payload it describes.
//!
//! The end-of-retail portal.dat holds 786 waves (scanned 2026-10-13).
//! 785 are PCM with an 18-byte header. The exception is `0x0A000393`:
//! format tag `0x0055` (`WAVE_FORMAT_MPEGLAYER3`), a 30-byte
//! `MPEGLAYER3WAVEFORMAT` header, and 5120 bytes of bare MPEG-2.5
//! Layer III frames (11025 Hz mono). ACE `Wave.cs` `ExportWave` gives
//! it a `.mp3` extension (`Header[0] == 0x55`) and names it as the
//! 30-byte exception.
//!
//! ## Wire layout
//!
//! From `external/DatReaderWriter/DatReaderWriter/dats.xml`:
//!
//! ```text
//! [u32 id]                 // matches DAT directory entry
//! [i32 _header_size]       // byte length of the header below
//! [i32 _data_size]         // byte length of the payload
//! [u8 × _header_size header]   // WAVEFORMATEX (18 bytes; 30 for 0x0A000393)
//! [u8 × _data_size data]       // raw PCM samples (MP3 frames for 0x0A000393)
//! ```
//!
//! Verified against retail `0x0A000002`: header_size=18, data_size=7046
//! (per `external/DatReaderWriter/.../WaveTests.cs:62-63`).
//!
//! ## WAVEFORMATEX header (18 bytes)
//!
//! The header mirrors Microsoft's `WAVEFORMATEX` struct
//! (`mmsystem.h`):
//!
//! ```text
//! [u16 format_tag]         // 1 = PCM; 0x55 = MPEG Layer III (0x0A000393 only)
//! [u16 num_channels]
//! [u32 sample_rate]
//! [u32 avg_bytes_per_sec]  // sample_rate × num_channels × bytes_per_sample
//! [u16 block_align]        // num_channels × bytes_per_sample
//! [u16 bits_per_sample]
//! [u16 cb_size]            // bytes after these 18: 0 for PCM, 12 for the MP3 wave
//! ```
//!
//! The MP3 wave's 12 extra bytes are the `MPEGLAYER3WAVEFORMAT` tail
//! (`mmreg.h`): `[u16 wID][u32 fdwFlags][u16 nBlockSize]
//! [u16 nFramesPerBlock][u16 nCodecDelay]`. Nothing here reads them.
//!
//! ## Web Audio integration (H3-C/D)
//!
//! Browsers can't decode raw PCM samples directly via
//! `AudioContext.decodeAudioData` — they expect a RIFF/WAV container.
//! Helper `to_riff_wav(&self) -> Vec<u8>` wraps the (header, data) pair
//! in a standard 44-byte RIFF/WAVE/`fmt `/`data` chunk structure that
//! `decodeAudioData` accepts.
//!
//! `to_browser_bytes(&self) -> Vec<u8>` is what `fetchWave` hands to
//! the browser (audio-4, 2026-10-13): the RIFF wrap for PCM, and the
//! bare `data` stream for the MP3 wave. A RIFF with format tag 0x55 is
//! legal MP3-in-WAV, but it needs a WAV demuxer that takes it. Firefox's
//! accepts only PCM, float, A-law and µ-law, so `decodeAudioData` rejects
//! it there. Every engine decodes a raw MP3 stream.

use binrw::{BinRead, binread};

use super::sound_table::SoundTable;

/// Top byte of every Wave DAT ID (`0x0A000000..=0x0AFFFFFF`).
pub const WAVE_DID_PREFIX: u32 = 0x0A;

/// audio-1 (2026-10-13): the distinct Wave DIDs a SoundTable names, sorted.
///
/// This is retail's load set for the table. `SoundTableData::UnPack`
/// (`acclient.c:385399`) calls `SoundManager::CreateSound` for every variant
/// whose `sound_id_` is non-zero (`:385486-385488`), and `CreateSound`
/// (`:383707`) refcounts one `SoundBuf` per id. That is why the result is
/// deduped and skips 0. Ids outside the Wave range are dropped too, so a
/// caller never queues a record that cannot be a Wave. The web client's
/// opt-in `?wavePrefetch=on` queue prefetches these bytes when a table is
/// installed.
pub fn sound_table_wave_ids(table: &SoundTable) -> Vec<u32> {
    let mut ids: Vec<u32> = table
        .sounds
        .values()
        .flat_map(|sd| sd.entries.iter().map(|e| e.wave_did))
        .filter(|&did| did != 0 && (did >> 24) == WAVE_DID_PREFIX)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// 18 = canonical `WAVEFORMATEX` size, and the header size of every
/// retail PCM wave. The one compressed retail wave, `0x0A000393`
/// (MP3), has a 30-byte `MPEGLAYER3WAVEFORMAT` header: these 18 bytes
/// with `cb_size = 12`, then the MP3 fields. [`Wave::pcm_format`]
/// decodes the leading 18 bytes of either.
pub const WAVEFORMATEX_SIZE: usize = 18;

/// `WAVEFORMATEX::wFormatTag` for PCM (`WAVE_FORMAT_PCM`, `mmreg.h`).
/// 785 of the 786 end-of-retail waves use it.
pub const WAVE_FORMAT_PCM: u16 = 0x0001;

/// `WAVEFORMATEX::wFormatTag` for MPEG Layer III
/// (`WAVE_FORMAT_MPEGLAYER3`, `mmreg.h`). Only `0x0A000393` uses it in
/// the end-of-retail portal.dat.
pub const WAVE_FORMAT_MPEGLAYER3: u16 = 0x0055;

/// Decoded `WAVEFORMATEX` view. Constructed from `Wave::header` via
/// [`Wave::pcm_format`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PcmFormat {
    pub format_tag: u16,
    pub num_channels: u16,
    pub sample_rate: u32,
    pub avg_bytes_per_sec: u32,
    pub block_align: u16,
    pub bits_per_sample: u16,
    pub cb_size: u16,
}

#[binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct Wave {
    pub id: u32,
    pub header_size: i32,
    pub data_size: i32,
    #[br(count = header_size.max(0) as usize)]
    #[serde(serialize_with = "serialize_bytes_summary")]
    pub header: Vec<u8>,
    #[br(count = data_size.max(0) as usize)]
    #[serde(serialize_with = "serialize_bytes_summary")]
    pub data: Vec<u8>,
}

/// Hex-summary byte arrays so the validator's per-field diff stays
/// tractable. Raw byte arrays would expand massive PCM bodies (hundreds
/// of KB per record) into JSON arrays that have ~no semantic value for
/// the parity comparison.
fn serialize_bytes_summary<S: serde::Serializer>(
    bytes: &Vec<u8>,
    s: S,
) -> std::result::Result<S::Ok, S::Error> {
    use serde::ser::SerializeStruct;
    let mut st = s.serialize_struct("BytesSummary", 2)?;
    st.serialize_field("len", &bytes.len())?;
    // First 16 bytes as a hex preview — enough to distinguish records.
    let preview_len = bytes.len().min(16);
    let preview: String = bytes[..preview_len].iter().map(|b| format!("{:02x}", b)).collect();
    st.serialize_field("preview", &preview)?;
    st.end()
}

impl Wave {
    pub fn unpack(bytes: &[u8]) -> Result<Self, binrw::Error> {
        let mut cursor = std::io::Cursor::new(bytes);
        Self::read(&mut cursor)
    }

    /// Decode the leading `WAVEFORMATEX` fields from `self.header`.
    /// Returns `None` if the header is shorter than 18 bytes.
    pub fn pcm_format(&self) -> Option<PcmFormat> {
        if self.header.len() < WAVEFORMATEX_SIZE {
            return None;
        }
        let h = &self.header;
        Some(PcmFormat {
            format_tag: u16::from_le_bytes([h[0], h[1]]),
            num_channels: u16::from_le_bytes([h[2], h[3]]),
            sample_rate: u32::from_le_bytes([h[4], h[5], h[6], h[7]]),
            avg_bytes_per_sec: u32::from_le_bytes([h[8], h[9], h[10], h[11]]),
            block_align: u16::from_le_bytes([h[12], h[13]]),
            bits_per_sample: u16::from_le_bytes([h[14], h[15]]),
            cb_size: u16::from_le_bytes([h[16], h[17]]),
        })
    }

    /// True when the header's format tag is [`WAVE_FORMAT_MPEGLAYER3`]:
    /// `data` is then a bare MPEG Layer III stream, not PCM samples.
    /// ACE `Wave.cs` `ExportWave` tests the tag's low byte (`Header[0] == 0x55`).
    pub fn is_mp3(&self) -> bool {
        self.pcm_format().map(|f| f.format_tag) == Some(WAVE_FORMAT_MPEGLAYER3)
    }

    /// audio-4 (2026-10-13): the bytes to hand to
    /// `AudioContext.decodeAudioData`. PCM records get the
    /// [`Self::to_riff_wav`] wrap. The MP3 record (`0x0A000393`) gets
    /// its raw `data`, because a RIFF with format tag 0x55 fails in
    /// PCM-only WAV demuxers (Firefox) while every engine decodes a bare
    /// MP3 stream. WebAC's `SoundPlayer` makes the same split
    /// (`wave.isMP3 ? wave.data : wave.toWavBuffer()`).
    pub fn to_browser_bytes(&self) -> Vec<u8> {
        if self.is_mp3() {
            self.data.clone()
        } else {
            self.to_riff_wav()
        }
    }

    /// Build a self-contained RIFF/WAV blob from this record's
    /// (header, data) pair. For a PCM record the result is decodable by
    /// `AudioContext.decodeAudioData` directly; browser callers should
    /// use [`Self::to_browser_bytes`], which also handles the MP3 wave.
    ///
    /// Structure (RIFF/WAVE/fmt /data):
    /// ```text
    /// "RIFF"              4 bytes
    /// total_size (LE)     4 bytes  // 36 + header_data_len + data.len()
    /// "WAVE"              4 bytes
    /// "fmt "              4 bytes
    /// fmt_chunk_size (LE) 4 bytes  // = self.header.len() (typically 18)
    /// header bytes        N bytes  // WAVEFORMATEX payload (typically 18 bytes)
    /// "data"              4 bytes
    /// data_chunk_size LE  4 bytes  // = self.data.len()
    /// data bytes          M bytes  // raw PCM
    /// ```
    pub fn to_riff_wav(&self) -> Vec<u8> {
        let fmt_size = self.header.len() as u32;
        let data_size = self.data.len() as u32;
        // RIFF size = (everything after `RIFF` + 4-byte size field)
        // = 4 ("WAVE") + 8 ("fmt " + size) + fmt_size + 8 ("data" + size) + data_size
        let riff_size = 4 + 8 + fmt_size + 8 + data_size;
        let mut buf = Vec::with_capacity(8 + riff_size as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&riff_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&fmt_size.to_le_bytes());
        buf.extend_from_slice(&self.header);
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        buf.extend_from_slice(&self.data);
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_wave(id: u32, header: &[u8], data: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&(header.len() as i32).to_le_bytes());
        buf.extend_from_slice(&(data.len() as i32).to_le_bytes());
        buf.extend_from_slice(header);
        buf.extend_from_slice(data);
        buf
    }

    fn synthetic_pcm_header(channels: u16, sample_rate: u32, bits: u16) -> Vec<u8> {
        let block_align = channels * (bits / 8);
        let avg_bps = sample_rate * block_align as u32;
        let mut h = Vec::with_capacity(WAVEFORMATEX_SIZE);
        h.extend_from_slice(&1u16.to_le_bytes()); // PCM
        h.extend_from_slice(&channels.to_le_bytes());
        h.extend_from_slice(&sample_rate.to_le_bytes());
        h.extend_from_slice(&avg_bps.to_le_bytes());
        h.extend_from_slice(&block_align.to_le_bytes());
        h.extend_from_slice(&bits.to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes()); // cb_size
        assert_eq!(h.len(), WAVEFORMATEX_SIZE);
        h
    }

    #[test]
    fn synthetic_wave_roundtrips_with_pcm_format_decode() {
        let header = synthetic_pcm_header(2, 22050, 16);
        let data: Vec<u8> = (0..128).map(|i| (i & 0xff) as u8).collect();
        let buf = pack_wave(0x0A_00_AB_CD, &header, &data);
        let w = Wave::unpack(&buf).unwrap();
        assert_eq!(w.id, 0x0A00ABCD);
        assert_eq!(w.header_size, 18);
        assert_eq!(w.data_size, 128);
        assert_eq!(w.header, header);
        assert_eq!(w.data, data);
        let fmt = w.pcm_format().unwrap();
        assert_eq!(fmt.format_tag, 1);
        assert_eq!(fmt.num_channels, 2);
        assert_eq!(fmt.sample_rate, 22050);
        assert_eq!(fmt.bits_per_sample, 16);
        assert_eq!(fmt.block_align, 4);
        assert_eq!(fmt.avg_bytes_per_sec, 88200);
        assert_eq!(fmt.cb_size, 0);
    }

    #[test]
    fn to_riff_wav_produces_decodable_riff() {
        let header = synthetic_pcm_header(1, 11025, 8);
        let data: Vec<u8> = (0..200).map(|i| (i & 0xff) as u8).collect();
        let w = Wave {
            id: 0x0A_00_00_01,
            header_size: header.len() as i32,
            data_size: data.len() as i32,
            header: header.clone(),
            data: data.clone(),
        };
        let riff = w.to_riff_wav();
        // RIFF/WAVE magic
        assert_eq!(&riff[0..4], b"RIFF");
        assert_eq!(&riff[8..12], b"WAVE");
        assert_eq!(&riff[12..16], b"fmt ");
        // fmt chunk size = 18
        let fmt_size = u32::from_le_bytes(riff[16..20].try_into().unwrap());
        assert_eq!(fmt_size, WAVEFORMATEX_SIZE as u32);
        // After 20 + 18 = 38, we expect "data"
        assert_eq!(&riff[38..42], b"data");
        let data_size = u32::from_le_bytes(riff[42..46].try_into().unwrap());
        assert_eq!(data_size, 200);
        // Total RIFF size header (offset 4..8): 4 + 8 + 18 + 8 + 200 = 238
        let riff_size = u32::from_le_bytes(riff[4..8].try_into().unwrap());
        assert_eq!(riff_size, 238);
        // Total blob size: 8 + 238 = 246
        assert_eq!(riff.len(), 246);
    }

    fn sound_data(wave_dids: &[u32]) -> crate::file_type::sound_table::SoundData {
        use crate::file_type::sound_table::{SoundData, SoundEntry};
        SoundData {
            entries: wave_dids
                .iter()
                .map(|&wave_did| SoundEntry {
                    wave_did,
                    priority: 0.5,
                    probability: 1.0,
                    volume: 1.0,
                })
                .collect(),
            unknown: 0,
        }
    }

    #[test]
    fn sound_table_wave_ids_dedupes_skips_zero_and_keeps_only_waves() {
        let mut sounds = std::collections::HashMap::new();
        // The same wave under two Sound enums, a zero variant (retail skips
        // it: `if ( v18.id ) CreateSound`), and a non-Wave id.
        sounds.insert(0x46, sound_data(&[0x0A00_0010, 0x0A00_0002, 0]));
        sounds.insert(0x47, sound_data(&[0x0A00_0002, 0x2000_0001]));
        sounds.insert(0x48, sound_data(&[]));
        sounds.insert(0x49, sound_data(&[0x0A00_0001]));
        let table = SoundTable {
            id: 0x2000_0014,
            hash_key: 0,
            hashes: std::collections::HashMap::new(),
            sounds,
        };
        assert_eq!(
            sound_table_wave_ids(&table),
            vec![0x0A00_0001, 0x0A00_0002, 0x0A00_0010]
        );
    }

    #[test]
    fn sound_table_wave_ids_of_an_empty_table_is_empty() {
        let table = SoundTable {
            id: 0x2000_0001,
            hash_key: 0,
            hashes: std::collections::HashMap::new(),
            sounds: std::collections::HashMap::new(),
        };
        assert!(sound_table_wave_ids(&table).is_empty());
    }

    /// Probe the retail DAT's 0x0A000002 record and confirm:
    ///   - header is exactly 18 bytes (WAVEFORMATEX),
    ///   - data is the expected 7046-byte PCM payload, per the
    ///     DatReaderWriter EOR test (`WaveTests.cs:62-63`),
    ///   - the PCM format decodes to a sensible sample rate range.
    #[test]
    fn probe_retail_wave_0x0a000002() {
        use crate::DatDatabase;
        use crate::utils::get_portal_dat_path;
        let path = if let Some(p) = get_portal_dat_path() {
            p
        } else {
            let c = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
            if c.exists() {
                c
            } else {
                eprintln!("[probe_retail_wave_0x0a000002] SKIP — no dat");
                return;
            }
        };
        let dat = DatDatabase::new(&path).expect("open dat");
        let bytes = dat.get_file(0x0A_00_00_02).expect("0x0A000002 must exist");
        let wave = Wave::unpack(&bytes).expect("Wave::unpack");
        assert_eq!(wave.id, 0x0A_00_00_02);
        assert_eq!(wave.header_size, 18);
        assert_eq!(wave.data_size, 7046);
        let fmt = wave.pcm_format().expect("WAVEFORMATEX header");
        assert_eq!(fmt.format_tag, 1, "retail audio is PCM");
        // Sanity range — AC's voice + ambient samples typically sit at
        // 11025 / 22050 / 44100 Hz, 1 or 2 channels, 8 or 16 bit.
        assert!(
            matches!(fmt.sample_rate, 8000..=48000),
            "sample_rate={} outside 8k..48k",
            fmt.sample_rate
        );
        assert!(matches!(fmt.num_channels, 1 | 2));
        assert!(matches!(fmt.bits_per_sample, 8 | 16));
        eprintln!(
            "[probe_retail_wave_0x0a000002] {} Hz {} ch {} bit, header={}B data={}B",
            fmt.sample_rate, fmt.num_channels, fmt.bits_per_sample,
            wave.header_size, wave.data_size,
        );
        // RIFF wrap produces correct sizes.
        let riff = wave.to_riff_wav();
        assert_eq!(riff.len(), 8 + 4 + 8 + 18 + 8 + 7046, "RIFF total");
    }

    /// The 30-byte `MPEGLAYER3WAVEFORMAT` header of retail `0x0A000393`,
    /// byte for byte (end-of-retail client_portal.dat, scanned 2026-10-13).
    fn retail_mp3_header() -> Vec<u8> {
        let h: Vec<u8> = vec![
            0x55, 0x00, // format_tag = WAVE_FORMAT_MPEGLAYER3
            0x01, 0x00, // num_channels = 1
            0x11, 0x2b, 0x00, 0x00, // sample_rate = 11025
            0xc4, 0x09, 0x00, 0x00, // avg_bytes_per_sec = 2500
            0x01, 0x00, // block_align = 1
            0x00, 0x00, // bits_per_sample = 0
            0x0c, 0x00, // cb_size = 12
            0x01, 0x00, // wID
            0x02, 0x00, 0x00, 0x00, // fdwFlags
            0x04, 0x01, // nBlockSize = 260
            0x02, 0x00, // nFramesPerBlock
            0x71, 0x05, // nCodecDelay = 1393
        ];
        assert_eq!(h.len(), 30);
        h
    }

    #[test]
    fn to_browser_bytes_returns_the_raw_stream_for_an_mp3_wave() {
        let header = retail_mp3_header();
        // Leads with the same MPEG frame header as 0x0A000393 (ff e3 30 c4).
        let mut data: Vec<u8> = vec![0xff, 0xe3, 0x30, 0xc4];
        data.extend((0..60u8).map(|i| i.wrapping_mul(7)));
        let w = Wave::unpack(&pack_wave(0x0A00_0393, &header, &data)).unwrap();
        assert_eq!(w.header_size, 30);
        assert_eq!(w.data_size, 64);
        let fmt = w.pcm_format().expect("leading WAVEFORMATEX");
        assert_eq!(fmt.format_tag, WAVE_FORMAT_MPEGLAYER3);
        assert_eq!(fmt.num_channels, 1);
        assert_eq!(fmt.sample_rate, 11025);
        assert_eq!(fmt.cb_size, 12);
        assert!(w.is_mp3());
        assert_eq!(w.to_browser_bytes(), data, "MP3 wave goes to the browser unwrapped");
        // to_riff_wav itself is unchanged: a RIFF with a 30-byte fmt chunk.
        let riff = w.to_riff_wav();
        assert_eq!(&riff[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(riff[16..20].try_into().unwrap()), 30);
    }

    #[test]
    fn to_browser_bytes_is_the_riff_wrap_for_a_pcm_wave() {
        let header = synthetic_pcm_header(1, 22050, 16);
        let data: Vec<u8> = (0..64u8).collect();
        let w = Wave::unpack(&pack_wave(0x0A00_0002, &header, &data)).unwrap();
        assert_eq!(w.pcm_format().unwrap().format_tag, WAVE_FORMAT_PCM);
        assert!(!w.is_mp3());
        assert_eq!(w.to_browser_bytes(), w.to_riff_wav());
    }

    /// Probe retail `0x0A000393`, the one MP3 wave in the end-of-retail
    /// portal.dat: the 30-byte header above, 5120 bytes of MPEG frames,
    /// and `to_browser_bytes` hands that stream back unwrapped.
    #[test]
    fn probe_retail_mp3_wave_0x0a000393() {
        use crate::DatDatabase;
        use crate::utils::get_portal_dat_path;
        let path = match get_portal_dat_path() {
            Some(p) => p,
            None => {
                let c = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
                if !c.exists() {
                    eprintln!("[probe_retail_mp3_wave_0x0a000393] SKIP — no dat");
                    return;
                }
                c
            }
        };
        let dat = DatDatabase::new(&path).expect("open dat");
        let bytes = dat.get_file(0x0A_00_03_93).expect("0x0A000393 must exist");
        let wave = Wave::unpack(&bytes).expect("Wave::unpack");
        assert_eq!(wave.id, 0x0A_00_03_93);
        assert_eq!(wave.header, retail_mp3_header());
        assert_eq!(wave.data_size, 5120);
        assert!(wave.is_mp3());
        let out = wave.to_browser_bytes();
        assert_eq!(out, wave.data);
        // MPEG audio frame header: 11-bit sync, then layer bits 01 = Layer III.
        assert_eq!(out[0], 0xFF);
        assert_eq!(out[1] & 0xE0, 0xE0);
        assert_eq!((out[1] >> 1) & 0b11, 0b01);
    }
}
