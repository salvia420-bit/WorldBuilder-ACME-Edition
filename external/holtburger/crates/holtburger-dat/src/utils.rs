use binrw::{BinRead, BinWrite};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};

/// Rust review 2026-08-03 (F5/F6): bytes left between the cursor and EOF.
///
/// Used to bound `Vec::with_capacity` / `HashMap::with_capacity` reservations
/// against what the record could physically contain. Restores the cursor.
pub fn remaining_bytes<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<u64> {
    let pos = reader.stream_position()?;
    let end = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(pos))?;
    Ok(end.saturating_sub(pos))
}

/// Rust review 2026-08-03 (F5/F6): validate a DAT-supplied element count and
/// return a **reservation-safe** capacity for it.
///
/// Two distinct defects motivated this:
///
/// * **F5 (sign):** several `List<T>.Unpack` ports read the ACE `Int32` count as
///   `i32::read_le(reader)? as usize`. A negative count sign-extends to
///   `usize::MAX` (`0xFFFF_FFFF` on wasm32) and reached `with_capacity`
///   directly, aborting with `capacity overflow` before a single element was
///   read. `file_type/sound_table.rs:179` already had the `.max(0)` guard; these
///   sites did not. Callers now pass the count already widened from `i32`.
/// * **F6 (magnitude):** even a *positive* count is attacker-chosen — a 12-byte
///   MotionTable claiming `0xFFFF_FFFF` entries asked for tens of GB.
///
/// `min_elem_size` is the smallest number of bytes one element can occupy on the
/// wire, so `remaining / min_elem_size` is a hard ceiling on how many are
/// actually parseable. The returned capacity is only a **reservation hint** —
/// callers keep looping over the real `count`, and the per-element
/// `read_le(reader)?` still fails cleanly at EOF, so parse semantics are
/// unchanged for every well-formed record.
pub fn safe_capacity<R: Read + Seek>(
    reader: &mut R,
    count: usize,
    min_elem_size: usize,
) -> binrw::BinResult<usize> {
    let ceiling = remaining_bytes(reader)? / (min_elem_size.max(1) as u64);
    Ok(count.min(ceiling as usize))
}

pub fn read_compressed_u32<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<u32> {
    let b0 = u8::read(reader)?;
    if (b0 & 0x80) == 0 {
        Ok(b0 as u32)
    } else {
        let b1 = u8::read(reader)?;
        if (b0 & 0x40) == 0 {
            Ok(((b0 as u32 & 0x7F) << 8) | b1 as u32)
        } else {
            let s = u16::read_le(reader)?;
            Ok(((((b0 as u32 & 0x3F) << 8) | b1 as u32) << 16) | s as u32)
        }
    }
}

pub fn write_compressed_u32<W: Write + Seek>(writer: &mut W, val: u32) -> binrw::BinResult<()> {
    if val > 0x3FFF_FFFF {
        return Err(binrw::Error::Custom {
            pos: writer.stream_position()?,
            err: Box::new("u32 value too large for compressed format (>30 bits)"),
        });
    }

    if val < 0x80 {
        (val as u8).write(writer)?;
    } else if val < 0x4000 {
        let b0 = 0x80 | ((val >> 8) & 0x3F) as u8;
        let b1 = (val & 0xFF) as u8;
        b0.write(writer)?;
        b1.write(writer)?;
    } else {
        let b0 = 0xC0 | ((val >> 24) & 0x3F) as u8;
        let b1 = ((val >> 16) & 0xFF) as u8;
        let s = (val & 0xFFFF) as u16;
        b0.write(writer)?;
        b1.write(writer)?;
        s.write_le(writer)?;
    }
    Ok(())
}

pub fn read_smart_vec<T, R, F>(reader: &mut R, mut read_item: F) -> binrw::BinResult<Vec<T>>
where
    R: Read + Seek,
    F: FnMut(&mut R) -> binrw::BinResult<T>,
{
    let count = read_compressed_u32(reader)? as usize;
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        values.push(read_item(reader)?);
    }
    Ok(values)
}

pub fn read_smart_map<K, T, R, FK, FV>(
    reader: &mut R,
    mut read_key: FK,
    mut read_value: FV,
) -> binrw::BinResult<HashMap<K, T>>
where
    R: Read + Seek,
    K: Eq + std::hash::Hash,
    FK: FnMut(&mut R) -> binrw::BinResult<K>,
    FV: FnMut(&mut R) -> binrw::BinResult<T>,
{
    let count = read_compressed_u32(reader)? as usize;
    let mut values = HashMap::with_capacity(count);
    for _ in 0..count {
        let key = read_key(reader)?;
        values.insert(key, read_value(reader)?);
    }
    Ok(values)
}

/// Read a "byte-length-prefix" pstring — a `length` field of
/// `size_of_length` bytes (1 / 2 / 4), followed by `length`
/// Windows-1252 bytes.
///
/// **Does NOT handle the AC1Legacy `PStringBase<char>` quirks** (no
/// 0xFFFF u16 → u32 length escape, no 4-byte align-pad after the
/// bytes). If the AC schema you are reading is annotated as
/// `<AC1LegacyPStringBase>` or `<PStringBase type="char">`, use
/// [`read_pstring_char`] instead — it embeds both quirks.
///
/// Retained for callers that need a non-`PStringBase<char>` width
/// (e.g. `size_of_length = 1` for inline byte-prefixed names, or
/// `size_of_length = 4` for the rare uint-length-prefixed payloads
/// in StringTable). Wave J2 (2026-05-27) migrated all known
/// `PStringBase<char>` callers in `holtburger-dat` to
/// [`read_pstring_char`]; new code reading that schema annotation
/// MUST use the corrected primitive.
pub fn read_pstring<R: Read + Seek>(
    reader: &mut R,
    size_of_length: u32,
) -> binrw::BinResult<String> {
    let length = match size_of_length {
        1 => u8::read(reader)? as usize,
        2 => u16::read_le(reader)? as usize,
        4 => u32::read_le(reader)? as usize,
        _ => {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "Unsupported PString length size".to_string(),
            });
        }
    };

    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer)?;

    // Asheron's Call usually uses Windows-1252 or similar.
    // encoding_rs can handle this.
    let (res, _, _) = encoding_rs::WINDOWS_1252.decode(&buffer);
    Ok(res.into_owned())
}

/// Read an AC1Legacy `PStringBase<char>` — the canonical AC string
/// format used by `CContractTable`, `CharGen`, and other DAT records
/// that go through retail's `PStringBase<char>::UnPack`.
///
/// # Wire format (per `acclient.c:296509-296568`)
///
/// ```text
///   u16 length                          (if 0xFFFF, follow with u32 length)
///   length × u8 Windows-1252 bytes
///   pad to 4-byte boundary              (acclient.c:296564-296566)
/// ```
///
/// The `0xFFFF` u16 sentinel followed by a `u32` extended length is
/// the load-bearing detail that distinguishes this from
/// [`read_pstring`] — retail strings exceeding 65,534 bytes
/// (description text, multi-line UI strings) would silently truncate
/// or misalign under the older primitive.
///
/// The 4-byte align-pad **after** the string body is also part of the
/// retail UnPack contract, mirroring `acclient.c:296564-296566`. ACE
/// DatLoader's `AC1LegacyPStringBase` reader implements the same
/// pattern.
///
/// # Trailing NUL stripping
///
/// Retail's UnPack has a subtle quirk at `acclient.c:296547-296550`
/// where it writes a NUL past the buffer end and then decrements
/// `m_len` if the byte before the NUL was also NUL. This means the
/// on-wire string may include trailing NUL bytes that the retail
/// client trims silently. We strip trailing NULs here to match the
/// observed behaviour (most retail strings have none, but the EoR
/// `Contract.questflag_*` strings sometimes do).
///
/// # When to use which `read_pstring*`
///
/// - **[`read_pstring_char`] (this function)** — for any DAT field
///   annotated `<PStringBase type="char">` or `<AC1LegacyPStringBase>`
///   in `dats.xml`. This is the correct primitive for new code.
/// - **[`read_pstring`]** — for callers that have already been
///   verified against retail (see its doc-comment for the safe set).
///
/// # Ported from
///
/// `crates/holtburger-dat/src/file_type/contract_table.rs` (Wave F
/// follow-on 2026-05-27). Promoted to `utils.rs` for reuse so future
/// `PStringBase<char>` parsers don't need their own copy.
pub fn read_pstring_char<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let len_u16 = u16::read_le(reader)?;
    let len = if len_u16 == 0xFFFF {
        u32::read_le(reader)? as usize
    } else {
        len_u16 as usize
    };
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    // Strip trailing NULs (retail's UnPack does this implicitly via the
    // m_len decrement at acclient.c:296549-296550 — most strings have
    // no NULs but the EoR `Contract.questflag_*` strings sometimes do).
    while buf.last() == Some(&0) {
        buf.pop();
    }
    // Align to 4-byte boundary.
    let pos = reader.stream_position()?;
    let pad = (4 - (pos % 4) as usize) % 4;
    if pad > 0 {
        reader.seek(SeekFrom::Current(pad as i64))?;
    }
    let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&buf);
    Ok(decoded.into_owned())
}

pub fn read_obfuscated_string<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let length = u16::read_le(reader)? as usize;
    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer)?;

    for byte in &mut buffer {
        // flip the bytes in the string to undo the obfuscation: i.e. 0xAB => 0xBA
        *byte = byte.rotate_left(4);
    }

    let (res, _, _) = encoding_rs::WINDOWS_1252.decode(&buffer);
    Ok(res.into_owned())
}

pub fn read_dotnet_string<R: Read + Seek>(reader: &mut R) -> binrw::BinResult<String> {
    let mut length = 0usize;
    let mut shift = 0usize;

    loop {
        let byte = u8::read(reader)?;
        length |= ((byte & 0x7F) as usize) << shift;

        if (byte & 0x80) == 0 {
            break;
        }

        shift += 7;
        if shift >= 35 {
            return Err(binrw::Error::AssertFail {
                pos: reader.stream_position().unwrap_or(0),
                message: "invalid .NET BinaryReader string length".to_string(),
            });
        }
    }

    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer)?;

    let (res, _, _) = encoding_rs::WINDOWS_1252.decode(&buffer);
    Ok(res.into_owned())
}

pub fn align_boundary<R: Read + Seek>(reader: &mut R, boundary: u32) -> binrw::BinResult<()> {
    let pos = reader.stream_position()?;
    let delta = pos % boundary as u64;
    if delta != 0 {
        reader.seek(SeekFrom::Current((boundary as u64 - delta) as i64))?;
    }
    Ok(())
}

/// AC SpellBase name/desc hash — the PJW-variant used **only** for
/// spell-formula component decryption. Ports `SpellBase.GetStringHash`
/// from `external/DatReaderWriter/DatReaderWriter/Types/SpellBase.cs:120-138`
/// (verbatim against the retail acclient algorithm).
///
/// ## NOT THE SAME as the other `string_hash` in this module!
///
/// - [`string_hash`] (this module): used for StringTable / EnumMapper /
///   DBObj name lookups. Algorithm: `((h << 4) | (h >> 28)) ^ signed`
///   followed by a `& 0x0FFFFFFF` mask each round.
/// - [`spellbase_string_hash`] (here): used for SpellBase component
///   decryption keys. Algorithm: `result = c + (result << 4)`, with a
///   conditional shift-fold-then-mask **only** when the top nibble is
///   nonzero.
///
/// Both treat input as Windows-1252 sign-extended bytes, but the
/// per-round mixing is different. The C# port at SpellBase.cs:120
/// uses the latter; the C# port at StringHashExtensions.cs uses the
/// former. This split is real in retail acclient.exe — different code
/// paths use different hash families. Don't merge them.
///
/// This is the **load-bearing** hash for two retail features:
///   1. Spell-formula component decryption (see [`decrypt_spell_components`]).
///   2. Taper rotation in player spell research (ACE-server formula at
///      `Server.Spells/Spells/SpellLogic.cs`, not yet ported).
pub fn spellbase_string_hash(s: &str) -> u32 {
    let (bytes, _, _) = encoding_rs::WINDOWS_1252.encode(s);
    let mut result: i64 = 0;
    for &b in bytes.iter() {
        let c = b as i8; // sbyte semantics, matching the C# `foreach (sbyte c in str)`
        result = (c as i64) + (result << 4);
        if (result & 0xF0000000) != 0 {
            result = (result ^ ((result & 0xF0000000) >> 24)) & 0x0FFFFFFF;
        }
    }
    result as u32
}

/// AC SpellBase component-decryption constants from
/// `acclient.exe` (S_CONSTANT discoveries documented in
/// `external/DatReaderWriter/DatReaderWriter/Types/SpellBase.cs:16-19`):
/// ```text
///   SPELLBASE_NAME_HASH_KEY = 0x12107680u  (303068800 decimal)
///   SPELLBASE_DESC_HASH_KEY = 0xBEADCF45u  (-1095905467 decimal, as signed)
/// ```
pub const SPELLBASE_NAME_HASH_KEY: u32 = 0x12107680;
pub const SPELLBASE_DESC_HASH_KEY: u32 = 0xBEADCF45;

/// Decrypt the 8-entry encrypted component array on
/// [`super::file_type::spell_table::SpellBase`] into the list of plaintext
/// `SpellComponentTable` IDs that make up the spell's cast formula
/// (scarabs + herbs/talismans, 1..198 per retail's component table).
///
/// Ports `SpellBase.DecryptComponents` from
/// `external/DatReaderWriter/DatReaderWriter/Types/SpellBase.cs:144-174`.
///
/// Algorithm:
/// ```text
///   key       = (hash(name) % NAME_KEY) + (hash(desc) % DESC_KEY)
///   comp[i]   = encrypted[i] == 0 ? 0 : (encrypted[i] - key)
///   if comp > 198: comp &= 0xFF      // accent-char fixup
/// ```
/// The 198 ceiling is the highest valid component ID in retail
/// ("Essence of Kemeroi" for Void spells, per the SpellComponentTable
/// dump at `apps/holtburger-web/data/spell-components.json`).
///
/// Returns the filtered list of non-zero component IDs in slot order;
/// trailing zero slots are dropped (matches C# `Where(x => x > 0)`).
/// Most spells use 4-5 components — a windup formula of "N scarabs +
/// 1 talisman" — so the returned `Vec` is typically 4..=6 long.
pub fn decrypt_spell_components(
    name: &str,
    description: &str,
    encrypted: &[u32; 8],
) -> Vec<u32> {
    let name_hash = spellbase_string_hash(name);
    let desc_hash = spellbase_string_hash(description);
    // Note: u32 modulo can't overflow since both operands are u32.
    // Addition WRAPS in the C# parser (uint arithmetic).
    let key = (name_hash % SPELLBASE_NAME_HASH_KEY)
        .wrapping_add(desc_hash % SPELLBASE_DESC_HASH_KEY);

    let mut out = Vec::with_capacity(8);
    for &enc in encrypted.iter() {
        if enc == 0 {
            continue;
        }
        let mut comp = enc.wrapping_sub(key);
        if comp > 198 {
            comp &= 0xFF;
        }
        if comp > 0 {
            out.push(comp);
        }
    }
    out
}

pub fn decompress_lrs(input: &[u8]) -> Vec<u8> {
    if input.len() < 4 {
        return input.to_vec();
    }

    let output_size = u32::from_le_bytes(input[0..4].try_into().unwrap()) as usize;
    let compressed_data = &input[4..];

    let mut output = Vec::with_capacity(output_size);
    let mut control_byte: u8 = 0;
    let mut control_bit: u8 = 0;
    let mut input_idx = 0;

    while output.len() < output_size && input_idx < compressed_data.len() {
        if control_bit == 0 {
            control_byte = compressed_data[input_idx];
            input_idx += 1;
            control_bit = 0x80;
        }

        if (control_byte & control_bit) != 0 {
            if input_idx + 1 >= compressed_data.len() {
                break;
            }
            let b1 = compressed_data[input_idx] as usize;
            let b2 = compressed_data[input_idx + 1] as usize;
            input_idx += 2;

            let offset = b1 | ((b2 & 0xF0) << 4);
            let length = (b2 & 0x0F) + 2;

            if offset == 0 {
                break;
            }

            for _ in 0..length {
                if output.len() >= output_size {
                    break;
                }
                let copy_idx = output.len().saturating_sub(offset);
                let byte = output[copy_idx];
                output.push(byte);
            }
        } else {
            output.push(compressed_data[input_idx]);
            input_idx += 1;
        }

        control_bit >>= 1;
    }

    output
}

pub trait FileExtPolyfill {
    fn read_exact_at_compat(&self, buf: &mut [u8], offset: u64) -> std::io::Result<()>;
    fn len_compat(&self) -> std::io::Result<u64>;
}

impl FileExtPolyfill for std::fs::File {
    #[cfg(unix)]
    fn read_exact_at_compat(&self, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
        use std::os::unix::fs::FileExt;
        self.read_exact_at(buf, offset)
    }

    #[cfg(windows)]
    fn read_exact_at_compat(&self, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
        use std::os::windows::fs::FileExt;
        // Windows seek_read returns number of bytes read, so we loop to ensure exact read
        let mut read = 0;
        while read < buf.len() {
            let n = self.seek_read(&mut buf[read..], offset + read as u64)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "failed to fill whole buffer",
                ));
            }
            read += n;
        }
        Ok(())
    }

    // Wasm32 has no positional file APIs (and `wasm32-unknown-unknown` has
    // no real filesystem). The HBA-from-`File` reader is unreachable on
    // wasm32 — the browser client uses an HTTP-backed `ResourceSource`
    // (Phase 2 of emit-dynamic-site) — but the trait impl must exist for
    // the crate to cross-compile.
    #[cfg(all(not(unix), not(windows)))]
    fn read_exact_at_compat(&self, _buf: &mut [u8], _offset: u64) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "positional file reads are unavailable on this target; \
             use a non-File `ResourceSource` (e.g. HttpResourceSource)",
        ))
    }

    fn len_compat(&self) -> std::io::Result<u64> {
        Ok(self.metadata()?.len())
    }
}

// Bytes-backed positional reader. Used by `HbaReader<Vec<u8>>` to parse an
// HBA archive resident in memory — what `HttpResourceSource` does once a
// `fetch()` of the bundle resolves. Lets `holtburger-resource-http`
// (wasm32-only) re-use the same `HbaReader` parsing path that native
// File-backed callers use, so the 1084-test suite covers the bytes path
// transitively.
impl FileExtPolyfill for Vec<u8> {
    fn read_exact_at_compat(&self, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
        let end = offset
            .checked_add(buf.len() as u64)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "offset+len overflow"))?;
        if end > self.len() as u64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "positional read past end of in-memory buffer",
            ));
        }
        let start = offset as usize;
        buf.copy_from_slice(&self[start..start + buf.len()]);
        Ok(())
    }

    fn len_compat(&self) -> std::io::Result<u64> {
        Ok(self.len() as u64)
    }
}

/// Helper to find a portal.dat for testing/benchmarking purposes.
///
/// Priority 1: `HOLTBURGER_PORTAL_DAT` environment variable.
/// Priority 2: Repository-relative fallback (`dats/portal.dat` from workspace root).
pub fn get_portal_dat_path() -> Option<std::path::PathBuf> {
    if let Ok(path_str) = std::env::var("HOLTBURGER_PORTAL_DAT") {
        let path = std::path::PathBuf::from(path_str);
        if path.exists() {
            return Some(path);
        }
    }

    // Workspace-relative fallbacks
    let workspace_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../");

    // 1. Repository dats/ folder
    let repo_dats = workspace_root.join("dats/portal.dat");
    if repo_dats.exists() {
        return Some(repo_dats);
    }

    None
}

/// AC string-key hash. Used as the key for StringTable / EnumMapper /
/// DBObj name lookups in retail DAT files. Per-byte 4-bit shift-fold into
/// a 28-bit accumulator, with input treated as Windows-1252 (sign-extended
/// per byte).
///
/// **NOT** the same as [`holtburger_protocol::crypto::Hash32::compute`] —
/// that's the packet checksum (length-prefix + 32-bit chunk accumulator).
/// See `external/chorizite/DatReaderWriter.Extensions/StringHashExtensions.cs`
/// + the DRW.Extensions reading guide §5 for the parity history. Cross-port
/// parity with the WB.Terminal `chorizite-hash-string` command is asserted
/// in [`tests::cross_port_parity_with_wb_terminal_chorizite_hash_string`].
///
/// # Example
/// ```
/// use holtburger_dat::utils::string_hash;
/// assert_eq!(string_hash("A"), 0x00000041);
/// assert_eq!(string_hash("WalkForward"), 0x0085473E);
/// ```
pub fn string_hash(input: &str) -> u32 {
    // Encode as Windows-1252 (matches the C# Encoding.GetEncoding(1252)).
    // For ASCII inputs (motion command names, enum names — the AC norm)
    // this is a no-op identity mapping.
    let (encoded, _, _) = encoding_rs::WINDOWS_1252.encode(input);
    let mut h: u32 = 0;
    for &b in encoded.iter() {
        // Sign-extend per byte (mirrors the C# `(sbyte)b` cast).
        let signed = b as i8 as i32;
        h = ((h << 4) | (h >> 28)) ^ (signed as u32);
    }
    h & 0x0FFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_compressed_u32_roundtrip() {
        let test_values = vec![0, 1, 0x7F, 0x80, 0x3FFF, 0x4000, 0x3FFF_FFFF];

        for val in test_values {
            let mut buf = Vec::new();
            let mut writer = Cursor::new(&mut buf);
            write_compressed_u32(&mut writer, val).unwrap();

            let mut reader = Cursor::new(&buf);
            let read_val = read_compressed_u32(&mut reader).unwrap();
            assert_eq!(val, read_val, "Value 0x{:08X} failed roundtrip", val);
        }
    }

    #[test]
    fn test_write_compressed_u32_overflow() {
        let mut buf = Vec::new();
        let mut writer = Cursor::new(&mut buf);
        let res = write_compressed_u32(&mut writer, 0x4000_0000);
        assert!(res.is_err());
    }

    #[test]
    fn test_read_smart_vec() {
        let bytes = [0x02, 0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55];
        let mut reader = Cursor::new(bytes);

        let values = read_smart_vec(&mut reader, u32::read_le).unwrap();

        assert_eq!(values, vec![0x1122_3344, 0x5566_7788]);
    }

    #[test]
    fn test_read_smart_map() {
        let bytes = [
            0x02, // count
            0x01, 0x00, 0x00, 0x00, // key 1
            0xAA, 0xAA, 0x00, 0x00, // value 0xAAAA
            0x02, 0x00, 0x00, 0x00, // key 2
            0xBB, 0xBB, 0x00, 0x00, // value 0xBBBB
        ];
        let mut reader = Cursor::new(bytes);

        let values = read_smart_map(&mut reader, u32::read_le, u32::read_le).unwrap();

        assert_eq!(values.get(&1), Some(&0x0000_AAAA));
        assert_eq!(values.get(&2), Some(&0x0000_BBBB));
    }

    #[test]
    fn test_decompress_lrs_literal() {
        let input = vec![
            4, 0, 0, 0,    // Size 4
            0x00, // Control byte: all literals (0)
            0xAA, 0xBB, 0xCC, 0xDD,
        ];
        let decompressed = decompress_lrs(&input);
        assert_eq!(decompressed, vec![0xAA, 0xBB, 0xCC, 0xDD]);
    }

    #[test]
    fn test_decompress_lrs_backref() {
        // Output should be "ABCABC"
        // 'A', 'B', 'C', then backref to 'A', 'B', 'C' (offset 3, length 1+2=3)
        // Control bit starts at 0x80.
        let input = vec![
            6, 0, 0, 0,    // Size 6
            0x10, // 0001 0000. bits 0..3 are 0 (literals), bit 4 is 1 (backref)
            b'A', b'B', b'C', 0x03, 0x01, // b1=3, b2=1 (length 1+2=3)
        ];
        let decompressed = decompress_lrs(&input);
        assert_eq!(decompressed, b"ABCABC");
    }

    #[test]
    fn test_read_dotnet_string() {
        let bytes = [0x05, b'H', b'e', b'l', b'l', b'o'];
        let mut reader = Cursor::new(bytes);

        let value = read_dotnet_string(&mut reader).unwrap();

        assert_eq!(value, "Hello");
    }

    /// Golden vectors for `string_hash`. Output values asserted against
    /// the C# port at WorldBuilder.Terminal `chorizite-hash-string` (which
    /// is itself a port of Chorizite/DatReaderWriter.Extensions/
    /// StringHashExtensions.cs::ComputeHash). If either port drifts, this
    /// test catches it.
    ///
    /// To regenerate the golden values:
    ///   $DOTNET_ROOT/dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
    ///   {"command":"chorizite-hash-string","input":"<your-string>"}
    #[test]
    fn string_hash_golden_vectors() {
        // Empty + single-char baselines.
        assert_eq!(string_hash(""), 0x00000000);
        assert_eq!(string_hash("A"), 0x00000041);
        assert_eq!(string_hash("a"), 0x00000061);

        // MotionCommand names (per Chorizite.Common/Enums/MotionCommand.cs).
        // Generated via:
        //   {"command":"chorizite-hash-string","input":"WalkForward"} → 0x0085473E
        //   {"command":"chorizite-hash-string","input":"NonCombat"}   → 0x0A59B42C
        assert_eq!(string_hash("WalkForward"), 0x0085473E);
        assert_eq!(string_hash("NonCombat"), 0x0A59B42C);
    }

    /// Verify the algorithm matches retail behaviour for inputs containing
    /// non-ASCII (Windows-1252-specific) characters. AC's StringTable
    /// occasionally carries Latin-1 supplement chars in NPC names.
    #[test]
    fn string_hash_handles_windows_1252_high_bytes() {
        // "é" (Windows-1252 0xE9) — sign-extends to -0x17 = 0xFFFFFFE9.
        // Recompute by hand: h=0, then b=0xE9 → signed=-23 → ((0<<4)|0)^0xFFFFFFE9 = 0xFFFFFFE9.
        // Mask 0x0FFFFFFF → 0x0FFFFFE9.
        assert_eq!(string_hash("é"), 0x0FFF_FFE9);
    }

    /// Helper that writes a `PStringBase<char>` to a buffer using the
    /// retail-correct wire format (u16 length, 0xFFFF escape to u32,
    /// padded to 4-byte boundary).
    fn write_pstring_char(buf: &mut Vec<u8>, s: &str) {
        let bytes = s.as_bytes();
        let len = bytes.len();
        if len < 0xFFFF {
            buf.extend_from_slice(&(len as u16).to_le_bytes());
        } else {
            buf.extend_from_slice(&0xFFFFu16.to_le_bytes());
            buf.extend_from_slice(&(len as u32).to_le_bytes());
        }
        buf.extend_from_slice(bytes);
        while buf.len() % 4 != 0 {
            buf.push(0);
        }
    }

    #[test]
    fn read_pstring_char_short_string() {
        let mut buf = Vec::new();
        write_pstring_char(&mut buf, "Hello");
        // Length prefix (2) + 5 chars + 1 pad byte = 8 bytes.
        assert_eq!(buf.len(), 8);

        let mut cursor = Cursor::new(buf);
        let s = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(s, "Hello");
        // Cursor should be at the 4-byte boundary past the string.
        assert_eq!(cursor.stream_position().unwrap(), 8);
    }

    #[test]
    fn read_pstring_char_empty_string() {
        let mut buf = Vec::new();
        write_pstring_char(&mut buf, "");
        // Length prefix (2) + 0 bytes + 2 pad bytes = 4 bytes.
        assert_eq!(buf.len(), 4);

        let mut cursor = Cursor::new(buf);
        let s = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(s, "");
        assert_eq!(cursor.stream_position().unwrap(), 4);
    }

    /// Verify the 0xFFFF length escape (acclient.c:296531-296535): a
    /// u16 length of 0xFFFF is a sentinel meaning "follow with u32
    /// length". Strings exceeding 65,534 bytes use this path.
    #[test]
    fn read_pstring_char_extended_length_escape() {
        let long_str: String = "A".repeat(0xFFFF + 1);
        let mut buf = Vec::new();
        write_pstring_char(&mut buf, &long_str);

        // Verify the format we wrote actually uses the u32 path.
        assert_eq!(&buf[0..2], &0xFFFFu16.to_le_bytes());
        assert_eq!(&buf[2..6], &((0xFFFF + 1) as u32).to_le_bytes());

        let mut cursor = Cursor::new(buf);
        let parsed = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(parsed.len(), long_str.len());
        assert_eq!(parsed, long_str);
    }

    /// Verify the 4-byte align-pad after the string body
    /// (acclient.c:296564-296566). A 1-byte string forces a 1-byte
    /// pad to bring the cursor from offset 3 → 4; subsequent reads
    /// must land on the 4-aligned offset, not the pad byte.
    #[test]
    fn read_pstring_char_align_pad_advances_cursor() {
        // Layout: u16 length (2 bytes, offsets 0..2) + 1 ASCII byte
        // (offset 2..3) + 1-byte pad (offset 3..4) + u32 canary
        // (offset 4..8).
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u16.to_le_bytes()); // length
        buf.push(b'X');
        buf.push(0); // 1 pad byte (cursor at offset 3 → 4)
        buf.extend_from_slice(&0xDEADBEEFu32.to_le_bytes()); // canary

        let mut cursor = Cursor::new(buf);
        let s = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(s, "X");
        assert_eq!(cursor.stream_position().unwrap(), 4);
        let canary = u32::read_le(&mut cursor).unwrap();
        assert_eq!(canary, 0xDEADBEEF);
    }

    /// Verify each of the 4 possible cursor positions after the body
    /// produces the correct align-pad (0, 1, 2, or 3 bytes). The
    /// post-string position depends on `(length_prefix_size + body)
    /// mod 4`.
    #[test]
    fn read_pstring_char_align_pad_all_remainders() {
        // length=0 → pre-string cursor at 2, post-string at 2, pad 2 → 4.
        // length=1 → pre-string cursor at 2, post-string at 3, pad 1 → 4.
        // length=2 → pre-string cursor at 2, post-string at 4, pad 0 → 4.
        // length=3 → pre-string cursor at 2, post-string at 5, pad 3 → 8.
        for n in 0..=3usize {
            let s: String = "A".repeat(n);
            let mut buf = Vec::new();
            write_pstring_char(&mut buf, &s);
            // Append a u32 canary so we can verify cursor lands on the
            // right boundary.
            buf.extend_from_slice(&0xCAFEBABEu32.to_le_bytes());

            let mut cursor = Cursor::new(buf);
            let parsed = read_pstring_char(&mut cursor).unwrap();
            assert_eq!(parsed, s, "length {} body mismatch", n);
            // Cursor MUST be on a 4-byte boundary now.
            let pos = cursor.stream_position().unwrap();
            assert_eq!(pos % 4, 0, "length {} cursor not 4-aligned: {}", n, pos);

            let canary = u32::read_le(&mut cursor).unwrap();
            assert_eq!(canary, 0xCAFEBABE, "length {} canary not aligned", n);
        }
    }

    /// Verify trailing NUL stripping (acclient.c:296547-296550). Some
    /// retail EoR `Contract.questflag_*` strings have NUL bytes baked
    /// into the on-wire length; retail strips them via the implicit
    /// `m_len` decrement, so we mirror that.
    #[test]
    fn read_pstring_char_strips_trailing_nuls() {
        // Build a 4-byte body of "AB\0\0" — length prefix 4, no pad needed.
        let mut buf = Vec::new();
        buf.extend_from_slice(&4u16.to_le_bytes()); // length
        buf.extend_from_slice(b"AB\0\0");
        // length=4, pre-string cursor 2, post-string 6, pad to 8.
        buf.extend_from_slice(&[0u8, 0u8]); // 2-byte pad

        let mut cursor = Cursor::new(buf);
        let s = read_pstring_char(&mut cursor).unwrap();
        assert_eq!(s, "AB");
        assert_eq!(cursor.stream_position().unwrap(), 8);
    }
}
