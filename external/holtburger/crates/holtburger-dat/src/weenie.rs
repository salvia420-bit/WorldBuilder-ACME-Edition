use crate::Result;
use crate::utils::read_pstring_char;
use binrw::BinRead;
use binrw::io::Cursor;
use holtburger_common::Guid;
use holtburger_common::properties::{PropertyDataId, PropertyString, WorldObjectProperties};
use std::collections::HashMap;
use std::io::{Read, Seek};

#[derive(Debug, Clone, Default)]
pub struct Weenie {
    pub wcid: u32,
    pub weenie_type: u32,
    pub properties: WorldObjectProperties,
}

impl Weenie {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        Self::unpack_from_reader(&mut cursor)
    }

    pub fn unpack_from_reader<R: Read + Seek>(reader: &mut R) -> Result<Self> {
        let wcid = u32::read_le(reader)?;
        let weenie_type = u32::read_le(reader)?;
        let _flags = u32::read_le(reader)?;

        let mut weenie = Weenie {
            wcid,
            weenie_type,
            ..Default::default()
        };

        // Int Bucket
        let count_int = u16::read_le(reader)?;
        for _ in 0..count_int {
            let key = u32::read_le(reader)?;
            let value = i32::read_le(reader)?;
            weenie.properties.apply_raw_int(key, value);
        }

        // Int64 Bucket
        let count_int64 = u16::read_le(reader)?;
        for _ in 0..count_int64 {
            let key = u32::read_le(reader)?;
            let value = i64::read_le(reader)?;
            weenie.properties.apply_raw_int64(key, value);
        }

        // Bool Bucket
        let count_bool = u16::read_le(reader)?;
        for _ in 0..count_bool {
            let key = u32::read_le(reader)?;
            let value = u8::read(reader)? != 0;
            weenie.properties.apply_raw_bool(key, value);
        }

        // Float Bucket
        let count_float = u16::read_le(reader)?;
        for _ in 0..count_float {
            let key = u32::read_le(reader)?;
            let value = f64::read_le(reader)?;
            weenie.properties.apply_raw_float(key, value);
        }

        // String Bucket
        let count_string = u16::read_le(reader)?;
        for _ in 0..count_string {
            let key = u32::read_le(reader)?;
            let value = read_pstring_char(reader)?;
            weenie.properties.apply_raw_string(key, value);
        }

        // DID Bucket
        let count_did = u16::read_le(reader)?;
        for _ in 0..count_did {
            let key = u32::read_le(reader)?;
            let value = u32::read_le(reader)?;
            weenie.properties.apply_raw_did(key, Guid(value));
        }

        // IID Bucket
        let count_iid = u16::read_le(reader)?;
        for _ in 0..count_iid {
            let key = u32::read_le(reader)?;
            let value = u32::read_le(reader)?;
            weenie.properties.apply_raw_iid(key, Guid(value));
        }

        Ok(weenie)
    }

    pub fn name(&self) -> Option<&String> {
        self.properties.strings.get(&PropertyString::Name)
    }

    pub fn icon_id(&self) -> Option<u32> {
        self.properties.dids.get(&PropertyDataId::Icon).map(|g| g.0)
    }
}

#[derive(Debug, Clone, Default)]
pub struct WeenieTable {
    pub id: u32,
    pub entries: HashMap<u32, Weenie>,
}

impl WeenieTable {
    pub fn unpack(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);

        let id = u32::read_le(&mut cursor)?;
        let count = u16::read_le(&mut cursor)?;
        let _bucket_size = u16::read_le(&mut cursor)?;

        let mut entries = HashMap::with_capacity(count as usize);
        for _ in 0..count {
            let key = u32::read_le(&mut cursor)?;
            let weenie = Weenie::unpack_from_reader(&mut cursor)?;
            entries.insert(key, weenie);
        }

        Ok(Self { id, entries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wave J2 stress test (2026-05-27): verifies the migrated
    /// [`Weenie::unpack`] correctly handles the 0xFFFF u16 → u32
    /// length escape that the previous `read_pstring(_, 2) +
    /// align_boundary(_, 4)` pattern silently truncated. Retail's
    /// PStringBase<char>::UnPack (acclient.c:296531-296535) reads a
    /// u32 follow-up length when the u16 sentinel is 0xFFFF. The
    /// migration target [`read_pstring_char`] embeds this contract;
    /// the old `read_pstring` would have misread the length as 0xFFFF
    /// (65,535) and left the cursor 4 bytes early, corrupting all
    /// subsequent buckets in the Weenie body.
    ///
    /// We synth-construct a Weenie blob with a single string-bucket
    /// entry whose value is exactly 0xFFFF + 1 bytes (the smallest
    /// length that forces the escape path) and round-trip it through
    /// `Weenie::unpack`. The post-string DID/IID buckets are read
    /// after the string bucket — they MUST decode their u16 counts
    /// correctly, which means the string-bucket cursor advance was
    /// also correct.
    #[test]
    fn weenie_unpacks_pstring_char_above_0xffff_escape_threshold() {
        // Property key 1 = PropertyString::Name (per
        // holtburger-common::properties::property_keys::strings::Name).
        const STRING_KEY_NAME: u32 = 1;
        const LONG_LEN: usize = 0xFFFF + 1; // 65,536 — first byte past the u16 ceiling.

        let mut data = Vec::new();

        // Header: wcid + weenie_type + flags.
        data.extend_from_slice(&0xAABBCCDDu32.to_le_bytes()); // wcid
        data.extend_from_slice(&1u32.to_le_bytes()); // weenie_type
        data.extend_from_slice(&0u32.to_le_bytes()); // flags

        // Empty Int / Int64 / Bool / Float buckets.
        data.extend_from_slice(&0u16.to_le_bytes()); // count_int
        data.extend_from_slice(&0u16.to_le_bytes()); // count_int64
        data.extend_from_slice(&0u16.to_le_bytes()); // count_bool
        data.extend_from_slice(&0u16.to_le_bytes()); // count_float

        // String bucket: one entry (key=PropertyString::Name, value=long string).
        data.extend_from_slice(&1u16.to_le_bytes()); // count_string
        data.extend_from_slice(&STRING_KEY_NAME.to_le_bytes()); // property key

        // PStringBase<char> with extended length escape:
        //   u16 = 0xFFFF (sentinel)
        //   u32 = actual length (>= 0xFFFF)
        //   N bytes of body
        //   pad to 4-byte boundary
        data.extend_from_slice(&0xFFFFu16.to_le_bytes()); // length sentinel
        data.extend_from_slice(&(LONG_LEN as u32).to_le_bytes()); // u32 length
        data.extend(std::iter::repeat(b'X').take(LONG_LEN)); // body
        while data.len() % 4 != 0 {
            data.push(0); // align-pad
        }

        // Empty DID / IID buckets — these are the post-string-bucket
        // reads that verify the cursor was correctly advanced past
        // the long pstring + align-pad. If the migration regressed,
        // these u16 reads would consume garbage bytes from inside the
        // string body and the parse would either succeed-with-wrong-
        // counts or fail outright.
        data.extend_from_slice(&0u16.to_le_bytes()); // count_did
        data.extend_from_slice(&0u16.to_le_bytes()); // count_iid

        let weenie = Weenie::unpack(&data).expect("weenie with 65,536-byte name should parse");
        assert_eq!(weenie.wcid, 0xAABBCCDD);
        assert_eq!(weenie.weenie_type, 1);

        let name = weenie.name().expect("name property should be populated");
        assert_eq!(name.len(), LONG_LEN, "name length lost in escape path");
        assert!(
            name.chars().all(|c| c == 'X'),
            "name body bytes not preserved"
        );

        // Post-string buckets must have decoded as empty — if the
        // cursor was misaligned, .dids / .iids would either be Err or
        // would contain spurious entries.
        assert!(weenie.properties.dids.0.is_empty(), "DID bucket cursor drift");
        assert!(weenie.properties.iids.0.is_empty(), "IID bucket cursor drift");
    }
}
