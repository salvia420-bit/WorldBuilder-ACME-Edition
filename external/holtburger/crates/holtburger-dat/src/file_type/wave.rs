//! AC Wave (DatFileType `0x0A`) — raw audio sample data. Each
//! 0x0A000000–0x0A00FFFF record carries a `(header, data)` pair:
//! the header is a Windows-style `WAVEFORMATEX` blob (18 bytes for
//! retail Dereth's pure PCM samples) and the data is the raw waveform
//! payload referenced by it.
//!
//! ## Wire layout
//!
//! From `external/DatReaderWriter/DatReaderWriter/dats.xml`:
//!
//! ```text
//! [u32 id]                 // matches DAT directory entry
//! [i32 _header_size]       // byte length of the header below
//! [i32 _data_size]         // byte length of the PCM data
//! [u8 × _header_size header]   // WAVEFORMATEX (typically 18 bytes)
//! [u8 × _data_size data]       // raw PCM samples
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
//! [u16 format_tag]         // 1 = PCM (the only retail value)
//! [u16 num_channels]
//! [u32 sample_rate]
//! [u32 avg_bytes_per_sec]  // sample_rate × num_channels × bytes_per_sample
//! [u16 block_align]        // num_channels × bytes_per_sample
//! [u16 bits_per_sample]
//! [u16 cb_size]            // 0 for plain PCM (always 0 in retail)
//! ```
//!
//! ## Web Audio integration (H3-C/D)
//!
//! Browsers can't decode raw PCM samples directly via
//! `AudioContext.decodeAudioData` — they expect a RIFF/WAV container.
//! Helper `to_riff_wav(&self) -> Vec<u8>` wraps the (header, data) pair
//! in a standard 44-byte RIFF/WAVE/`fmt `/`data` chunk structure that
//! `decodeAudioData` accepts.

use binrw::{BinRead, binread};

/// 18 = canonical retail PCM `WAVEFORMATEX` size. AC's audio assets
/// don't use compressed formats or extended chunk data, so every
/// retail header observed to date is exactly this size. Larger
/// headers parse correctly but aren't expected.
pub const WAVEFORMATEX_SIZE: usize = 18;

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

    /// Build a self-contained RIFF/WAV blob from this record's
    /// (header, data) pair. The result is decodable by
    /// `AudioContext.decodeAudioData` directly.
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
}
