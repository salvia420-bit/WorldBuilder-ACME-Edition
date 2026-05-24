//! MediaDesc — typeswitch sub-record used inside [`StateDesc::media`]
//! and in some other places. Each variant describes how a piece of
//! media (sound, image, movie, animation, jump, ...) is wired into a
//! UI element's state.
//!
//! Wire layout (DRW `<type name="MediaDesc" abstract="true">`):
//!
//! ```text
//!   MediaType   _media_type       (i32 on wire — DRW parent="int")
//!   MediaType   type_dup          (second copy, same value in retail)
//!   <variant payload per `_media_type`>
//! ```
//!
//! DRW handles 11/13 MediaType values (no Undef, no Stretch). Our
//! parser follows the same coverage — Undef/Stretch error out.

use crate::utils::read_compressed_u32;
use binrw::io::Seek;
use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[repr(u32)]
pub enum MediaType {
    Undef = 0x0,
    Movie = 0x1,
    Alpha = 0x2,
    Animation = 0x3,
    Cursor = 0x4,
    Image = 0x5,
    Jump = 0x6,
    Message = 0x7,
    Pause = 0x8,
    Sound = 0x9,
    State = 0xA,
    Fade = 0xB,
    Stretch = 0xC,
}

impl MediaType {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0x0 => Self::Undef,
            0x1 => Self::Movie,
            0x2 => Self::Alpha,
            0x3 => Self::Animation,
            0x4 => Self::Cursor,
            0x5 => Self::Image,
            0x6 => Self::Jump,
            0x7 => Self::Message,
            0x8 => Self::Pause,
            0x9 => Self::Sound,
            0xA => Self::State,
            0xB => Self::Fade,
            0xC => Self::Stretch,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum MediaDesc {
    Movie {
        file_name: String,
        stretch_to_full_screen: bool,
    },
    Alpha {
        file: u32,
    },
    Animation {
        duration: f32,
        /// DrawModeType enum (parent=uint).
        draw_mode: u32,
        frames: Vec<u32>,
    },
    Cursor {
        file: u32,
        x_hotspot: u32,
        y_hotspot: u32,
    },
    Image {
        file: u32,
        draw_mode: u32,
    },
    Jump {
        jump_item_index: u32,
        probability: f32,
    },
    Message {
        id: u32,
        probability: f32,
    },
    Pause {
        min_duration: f32,
        max_duration: f32,
    },
    Sound {
        file: u32,
        /// Sound enum (parent=uint).
        sound: u32,
    },
    State {
        state_id: u32,
        probability: f32,
    },
    Fade {
        start_alpha: f32,
        end_alpha: f32,
        duration: f32,
    },
}

impl MediaDesc {
    pub fn read_le<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<Self> {
        use binrw::BinRead;

        let media_type_raw = u32::read_le(reader)?;
        let media_type = MediaType::from_u32(media_type_raw).ok_or_else(|| binrw::Error::Custom {
            pos: reader.stream_position().unwrap_or(0),
            err: Box::new(format!("unknown MediaType 0x{media_type_raw:08X}")),
        })?;

        // Second copy of MediaType — DRW reads both, retail writes them
        // equal. We accept any value here but assert equality so a future
        // schema deviation surfaces loudly.
        let dup = u32::read_le(reader)?;
        if dup != media_type_raw {
            return Err(binrw::Error::Custom {
                pos: reader.stream_position().unwrap_or(0),
                err: Box::new(format!(
                    "MediaDesc duplicate-type mismatch: _media_type=0x{media_type_raw:08X} but Type=0x{dup:08X}"
                )),
            });
        }

        Ok(match media_type {
            MediaType::Movie => {
                let file_name = read_pstring_byte_compressed(reader)?;
                let stretch_to_full_screen = u8::read(reader)? != 0;
                Self::Movie { file_name, stretch_to_full_screen }
            }
            MediaType::Alpha => Self::Alpha { file: u32::read_le(reader)? },
            MediaType::Animation => {
                let duration = f32::read_le(reader)?;
                let draw_mode = u32::read_le(reader)?;
                let n = u32::read_le(reader)? as usize;
                let mut frames = Vec::with_capacity(n);
                for _ in 0..n {
                    frames.push(u32::read_le(reader)?);
                }
                Self::Animation { duration, draw_mode, frames }
            }
            MediaType::Cursor => Self::Cursor {
                file: u32::read_le(reader)?,
                x_hotspot: u32::read_le(reader)?,
                y_hotspot: u32::read_le(reader)?,
            },
            MediaType::Image => Self::Image {
                file: u32::read_le(reader)?,
                draw_mode: u32::read_le(reader)?,
            },
            MediaType::Jump => Self::Jump {
                jump_item_index: u32::read_le(reader)?,
                probability: f32::read_le(reader)?,
            },
            MediaType::Message => Self::Message {
                id: u32::read_le(reader)?,
                probability: f32::read_le(reader)?,
            },
            MediaType::Pause => Self::Pause {
                min_duration: f32::read_le(reader)?,
                max_duration: f32::read_le(reader)?,
            },
            MediaType::Sound => Self::Sound {
                file: u32::read_le(reader)?,
                sound: u32::read_le(reader)?,
            },
            MediaType::State => Self::State {
                state_id: u32::read_le(reader)?,
                probability: f32::read_le(reader)?,
            },
            MediaType::Fade => Self::Fade {
                start_alpha: f32::read_le(reader)?,
                end_alpha: f32::read_le(reader)?,
                duration: f32::read_le(reader)?,
            },
            MediaType::Undef | MediaType::Stretch => {
                return Err(binrw::Error::Custom {
                    pos: reader.stream_position().unwrap_or(0),
                    err: Box::new(format!(
                        "MediaDesc variant {media_type:?} not in DRW typeswitch — no documented wire layout"
                    )),
                });
            }
        })
    }
}

fn read_pstring_byte_compressed<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let len = read_compressed_u32(reader)? as usize;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&buf);
    Ok(decoded.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use binrw::io::Cursor;

    #[test]
    fn media_type_round_trip() {
        for v in [MediaType::Movie, MediaType::Sound, MediaType::Fade, MediaType::Stretch] {
            assert_eq!(MediaType::from_u32(v as u32), Some(v));
        }
        assert_eq!(MediaType::from_u32(0xFF), None);
    }

    #[test]
    fn media_desc_pause_decodes() {
        // _media_type + dup + min(0.5) + max(1.0)
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(MediaType::Pause as u32).to_le_bytes());
        bytes.extend_from_slice(&(MediaType::Pause as u32).to_le_bytes());
        bytes.extend_from_slice(&0.5f32.to_le_bytes());
        bytes.extend_from_slice(&1.0f32.to_le_bytes());

        let mut cursor = Cursor::new(bytes);
        match MediaDesc::read_le(&mut cursor).expect("parse pause") {
            MediaDesc::Pause { min_duration, max_duration } => {
                assert_eq!(min_duration, 0.5);
                assert_eq!(max_duration, 1.0);
            }
            _ => panic!("expected Pause"),
        }
    }

    #[test]
    fn media_desc_image_decodes() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(MediaType::Image as u32).to_le_bytes());
        bytes.extend_from_slice(&(MediaType::Image as u32).to_le_bytes());
        bytes.extend_from_slice(&0x06001234u32.to_le_bytes());
        bytes.extend_from_slice(&3u32.to_le_bytes()); // Alphablend

        let mut cursor = Cursor::new(bytes);
        match MediaDesc::read_le(&mut cursor).expect("parse image") {
            MediaDesc::Image { file, draw_mode } => {
                assert_eq!(file, 0x06001234);
                assert_eq!(draw_mode, 3);
            }
            _ => panic!("expected Image"),
        }
    }

    #[test]
    fn media_desc_duplicate_mismatch_errors() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(MediaType::Pause as u32).to_le_bytes());
        bytes.extend_from_slice(&(MediaType::Image as u32).to_le_bytes());
        let mut cursor = Cursor::new(bytes);
        assert!(MediaDesc::read_le(&mut cursor).is_err());
    }
}
