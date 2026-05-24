//! Font (DAT type 0x40, ID range `0x40000000..=0x40000FFF`).
//!
//! Bitmap-font record: header fields, an array of per-glyph descriptors
//! describing where to find each glyph inside a foreground/background
//! atlas surface, and references to those two atlas surfaces by DataID.
//!
//! Wire layout (matches DRW `Font` in `dats.xml` and acclient.h
//! `struct Font : DBObj`):
//!
//! ```text
//!   u32  id                     (DBObjHeaderFlags.HasId)
//!   u32  max_char_height
//!   u32  max_char_width
//!   u32  num_char_descs
//!   [FontCharDesc; num_char_descs]   (11 bytes each, unaligned)
//!   u32  num_horizontal_border_pixels
//!   u32  num_vertical_border_pixels
//!   i32  baseline_offset          (acclient.h says signed; DRW says uint —
//!                                  we follow acclient.h per the parser-
//!                                  mislabel discipline)
//!   u32  foreground_surface_data_id
//!   u32  background_surface_data_id
//! ```
//!
//! Real-record cross-check: Font 0x40000000 in retail portal.dat is
//! 11586 bytes = 36-byte fixed header/footer + 11 × 1050 char descs.
//! First char desc is U+0020 (space), second is U+0021 (`!`).

use binrw::BinRead;

/// Per-glyph atlas descriptor. 11 bytes, no padding (acclient.h marks
/// the C struct `__unaligned __declspec(align(1))`).
#[derive(BinRead, Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[br(little)]
pub struct FontCharDesc {
    /// Unicode code point this descriptor maps to.
    pub unicode: u16,
    /// X offset of this glyph within the atlas surface.
    pub offset_x: u16,
    /// Y offset of this glyph within the atlas surface.
    pub offset_y: u16,
    /// Glyph width in pixels.
    pub width: u8,
    /// Glyph height in pixels.
    pub height: u8,
    /// Signed horizontal kerning padding before the glyph.
    pub horizontal_offset_before: i8,
    /// Signed horizontal kerning padding after the glyph.
    pub horizontal_offset_after: i8,
    /// Signed vertical kerning padding before the glyph.
    pub vertical_offset_before: i8,
}

#[binrw::binread]
#[derive(Debug, Clone, serde::Serialize)]
#[br(little)]
pub struct Font {
    pub id: u32,
    pub max_char_height: u32,
    pub max_char_width: u32,
    #[br(temp)]
    num_char_descs: u32,
    #[br(count = num_char_descs)]
    pub char_descs: Vec<FontCharDesc>,
    pub num_horizontal_border_pixels: u32,
    pub num_vertical_border_pixels: u32,
    pub baseline_offset: i32,
    pub foreground_surface_data_id: u32,
    pub background_surface_data_id: u32,
}

impl Font {
    /// Parse a Font record from the raw bytes returned by a
    /// `ResourceSource`. Mirrors the [`Texture::unpack`] / [`Surface::unpack`]
    /// pattern so wasm-side callers don't have to take a direct `binrw`
    /// dependency.
    pub fn unpack(data: &[u8]) -> binrw::BinResult<Self> {
        let mut cursor = binrw::io::Cursor::new(data);
        <Self as binrw::BinRead>::read(&mut cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    /// First 32 bytes of retail Font 0x40000000 — enough to validate the
    /// header layout and first two char descs (space + '!').
    const FONT_0X40000000_PREFIX: &[u8] = &[
        // header
        0x00, 0x00, 0x00, 0x40, // id = 0x40000000
        0x10, 0x00, 0x00, 0x00, // max_char_height = 16
        0x10, 0x00, 0x00, 0x00, // max_char_width = 16
        0x1A, 0x04, 0x00, 0x00, // num_char_descs = 1050 (0x041A)
        // char desc 0: U+0020 (space)
        0x20, 0x00, // unicode
        0x04, 0x00, // offset_x = 4
        0x04, 0x00, // offset_y = 4
        0x03, // width = 3
        0x10, // height = 16
        0x00, // horizontal_offset_before = 0
        0x01, // horizontal_offset_after = 1
        0x00, // vertical_offset_before = 0
        // char desc 1: U+0021 ('!')
        0x21, 0x00, // unicode
        0x0F, 0x00, // offset_x = 15
        0x04, 0x00, // offset_y = 4
    ];

    #[test]
    fn font_char_desc_round_trips_real_bytes() {
        let mut cursor = Cursor::new(&FONT_0X40000000_PREFIX[16..27]);
        let desc = FontCharDesc::read(&mut cursor).expect("read first char desc");
        assert_eq!(desc.unicode, 0x0020);
        assert_eq!(desc.offset_x, 4);
        assert_eq!(desc.offset_y, 4);
        assert_eq!(desc.width, 3);
        assert_eq!(desc.height, 16);
        assert_eq!(desc.horizontal_offset_before, 0);
        assert_eq!(desc.horizontal_offset_after, 1);
        assert_eq!(desc.vertical_offset_before, 0);
    }

    #[test]
    fn font_header_parses_real_prefix() {
        // Sanity-check the header decode against retail bytes. Validates
        // field order + that the char-desc array starts where we expect.
        let mut cursor = Cursor::new(FONT_0X40000000_PREFIX);
        let id = u32::read_le(&mut cursor).unwrap();
        let max_h = u32::read_le(&mut cursor).unwrap();
        let max_w = u32::read_le(&mut cursor).unwrap();
        let n = u32::read_le(&mut cursor).unwrap();
        assert_eq!(id, 0x40000000);
        assert_eq!(max_h, 16);
        assert_eq!(max_w, 16);
        assert_eq!(n, 1050);

        // 36-byte fixed surround + 11-byte char descs accounts for the
        // full 11586-byte retail record exactly.
        let predicted = 36 + 11 * n as usize;
        assert_eq!(predicted, 11586);
    }
}
