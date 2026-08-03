use crate::messages::utils::{
    capacity_hint, read_packed_wclass_id, read_string16, write_packed_wclass_id, write_string16,
};
use crate::traits::{ProtocolPack, ProtocolUnpack};
use byteorder::{ByteOrder, LittleEndian, WriteBytesExt};

#[derive(Debug, Clone, PartialEq)]
pub struct OrderingResetData;

impl ProtocolUnpack for OrderingResetData {
    fn unpack(_data: &[u8], _offset: &mut usize) -> Option<Self> {
        Some(OrderingResetData)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CharacterErrorData {
    pub error_id: u32,
}

impl ProtocolUnpack for CharacterErrorData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let error_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(CharacterErrorData { error_id })
    }
}

impl ProtocolPack for CharacterErrorData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.error_id).unwrap();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BootAccountData {
    pub reason: Option<String>,
}

impl ProtocolUnpack for BootAccountData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset >= data.len() {
            return Some(BootAccountData { reason: None });
        }
        let reason = read_string16(data, offset)?;
        Some(BootAccountData {
            reason: Some(reason),
        })
    }
}

impl ProtocolPack for BootAccountData {
    fn pack(&self, buf: &mut Vec<u8>) {
        if let Some(reason) = &self.reason {
            write_string16(buf, reason);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MostlyConsecutiveIntSet {
    pub iterations: i32,
    pub values: Vec<i32>,
}

impl ProtocolUnpack for MostlyConsecutiveIntSet {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 4 > data.len() {
            return None;
        }
        let iterations_count = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        *offset += 4;

        let mut values = Vec::new();
        let mut current_iters = 0;
        while current_iters < iterations_count {
            if *offset + 4 > data.len() {
                return None;
            }
            let x = LittleEndian::read_i32(&data[*offset..*offset + 4]);
            *offset += 4;

            if x < 0 {
                current_iters += x.abs() - 1;
            } else {
                current_iters += 1;
            }
            values.push(x);
        }
        Some(MostlyConsecutiveIntSet {
            iterations: iterations_count,
            values,
        })
    }
}

impl ProtocolPack for MostlyConsecutiveIntSet {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_i32::<LittleEndian>(self.iterations).unwrap();
        for &val in &self.values {
            buf.write_i32::<LittleEndian>(val).unwrap();
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaggedIterationList {
    pub dat_file_type: i32,
    pub dat_file_id: i32,
    pub list: MostlyConsecutiveIntSet,
}

impl ProtocolUnpack for TaggedIterationList {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let dat_file_type = LittleEndian::read_i32(&data[*offset..*offset + 4]);
        let dat_file_id = LittleEndian::read_i32(&data[*offset + 4..*offset + 8]);
        *offset += 8;
        let list = MostlyConsecutiveIntSet::unpack(data, offset)?;
        Some(TaggedIterationList {
            dat_file_type,
            dat_file_id,
            list,
        })
    }
}

impl ProtocolPack for TaggedIterationList {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_i32::<LittleEndian>(self.dat_file_type).unwrap();
        buf.write_i32::<LittleEndian>(self.dat_file_id).unwrap();
        self.list.pack(buf);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DddInterrogationResponseData {
    pub language: u32,
    pub lists: Vec<TaggedIterationList>,
}

impl ProtocolUnpack for DddInterrogationResponseData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let language = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;

        let mut lists = Vec::new();
        for _ in 0..count {
            lists.push(TaggedIterationList::unpack(data, offset)?);
        }
        Some(DddInterrogationResponseData { language, lists })
    }
}

impl ProtocolPack for DddInterrogationResponseData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.language).unwrap();
        buf.write_u32::<LittleEndian>(self.lists.len() as u32)
            .unwrap();
        for list in &self.lists {
            list.pack(buf);
        }
    }
}

/// `DddInterrogation` (0xF7E5, S2C) payload. protocol.xml:8464-8468.
/// Fields: ServersRegion (uint), NameRuleLanguage (uint), ProductId (uint),
/// SupportedLanguages (PackableList<uint> = u32 count + count×u32).
#[derive(Debug, Clone, PartialEq)]
pub struct DddInterrogationData {
    pub servers_region: u32,
    pub name_rule_language: u32,
    pub product_id: u32,
    pub supported_languages: Vec<u32>,
}

impl ProtocolUnpack for DddInterrogationData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 16 > data.len() {
            return None;
        }
        let servers_region = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let name_rule_language = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let product_id = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;

        let mut supported_languages =
            Vec::with_capacity(capacity_hint(data, *offset, count as usize));
        for _ in 0..count {
            if *offset + 4 > data.len() {
                return None;
            }
            supported_languages.push(LittleEndian::read_u32(&data[*offset..*offset + 4]));
            *offset += 4;
        }
        Some(DddInterrogationData {
            servers_region,
            name_rule_language,
            product_id,
            supported_languages,
        })
    }
}

impl ProtocolPack for DddInterrogationData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.servers_region).unwrap();
        buf.write_u32::<LittleEndian>(self.name_rule_language)
            .unwrap();
        buf.write_u32::<LittleEndian>(self.product_id).unwrap();
        buf.write_u32::<LittleEndian>(self.supported_languages.len() as u32)
            .unwrap();
        for &lang in &self.supported_languages {
            buf.write_u32::<LittleEndian>(lang).unwrap();
        }
    }
}

/// `DddRequestDataMessage` (0xF7E3, C2S) payload. protocol.xml:7940-7942.
/// Fields: ResourceType (uint), ResourceId (DataId).
///
/// `resource_id` is a `DataId`, which the generated reader
/// (`DDD_RequestDataMessage.generated.cs:36`) decodes via `ReadPackedDWORD()` —
/// a 2-or-4-byte variable-width encoding, NOT a flat `uint`. We reuse the
/// canonical `read_packed_wclass_id`/`write_packed_wclass_id` codec
/// (`messages/utils.rs`), which mirrors C# `ReadPackedDWORD`/`WritePackedDword`
/// for a base-0 DataId: 2 bytes when `value <= 0x7FFF`, else a 4-byte high-bit
/// form (`((value >> 16) | 0x8000)` first u16, `value & 0xFFFF` second u16).
#[derive(Debug, Clone, PartialEq)]
pub struct DddRequestDataMessageData {
    pub resource_type: u32,
    pub resource_id: u32,
}

impl ProtocolUnpack for DddRequestDataMessageData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        // ResourceType (flat uint) + at least the 2-byte minimum of the
        // variable-width ResourceId PackedDWORD.
        if *offset + 6 > data.len() {
            return None;
        }
        let resource_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let resource_id = read_packed_wclass_id(data, offset);
        Some(DddRequestDataMessageData {
            resource_type,
            resource_id,
        })
    }
}

impl ProtocolPack for DddRequestDataMessageData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.resource_type).unwrap();
        write_packed_wclass_id(buf, self.resource_id);
    }
}

/// `DddErrorMessage` (0xF7E4, S2C) payload. protocol.xml:8455-8458.
/// Fields: ResourceType (uint), ResourceId (DataId), RError (uint).
///
/// `resource_id` is a `DataId` decoded via `ReadPackedDWORD()`
/// (`DDD_ErrorMessage.generated.cs:39`), NOT a flat `uint` — same variable-width
/// codec as [`DddRequestDataMessageData::resource_id`].
#[derive(Debug, Clone, PartialEq)]
pub struct DddErrorMessageData {
    pub resource_type: u32,
    pub resource_id: u32,
    pub r_error: u32,
}

impl ProtocolUnpack for DddErrorMessageData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        // ResourceType (flat uint) + at least the 2-byte minimum of the
        // variable-width ResourceId PackedDWORD + RError (flat uint).
        if *offset + 10 > data.len() {
            return None;
        }
        let resource_type = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let resource_id = read_packed_wclass_id(data, offset);
        if *offset + 4 > data.len() {
            return None;
        }
        let r_error = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        Some(DddErrorMessageData {
            resource_type,
            resource_id,
            r_error,
        })
    }
}

impl ProtocolPack for DddErrorMessageData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.resource_type).unwrap();
        write_packed_wclass_id(buf, self.resource_id);
        buf.write_u32::<LittleEndian>(self.r_error).unwrap();
    }
}

/// The compression-switched payload tail of a `DddDataMessage`. protocol.xml:8437-8453.
/// `Compression == 0x00` → `Uncompressed`; `Compression == 0x01` → `Compressed`
/// (carries a leading `FileSize` DWORD). Stored raw so unknown discriminants on the
/// wire are not rejected at this layer.
#[derive(Debug, Clone, PartialEq)]
pub enum DddDataPayload {
    Uncompressed(Vec<u8>),
    Compressed { file_size: u32, data: Vec<u8> },
}

/// `DddDataMessage` (0xF7E2, S2C) payload. protocol.xml:8437-8453.
///
/// `DataSize` counts the remaining bytes *including its own 4-byte DWORD*. On unpack
/// the byte count to read is `data_size - 4` (uncompressed) or `data_size - 8`
/// (compressed; the `FileSize` DWORD consumes the extra 4). `data_size` is validated
/// `>= skip` to guard against underflow. On pack `data_size` is recomputed from the
/// payload length + skip so round-trips are idempotent.
///
/// `dat_file` (DatFileType) and `compression` (CompressionType) are stored as raw
/// integers rather than narrowed enums so unknown wire discriminants are not rejected
/// here; consumers map them to enums as needed.
///
/// Wire widths follow the generated reader (`DDD_DataMessage.generated.cs:66-88`),
/// which is the byte authority: `DatFile` is an 8-byte `Int64`
/// (`(DatFileType)reader.ReadInt64()`; enum parent = `long`) and `Compression` is a
/// single byte (`(CompressionType)reader.ReadByte()`; `enum CompressionType : byte`).
/// `ResourceType`/`ResourceId`/`Iteration`/`Version`/`DataSize` are flat `uint`s
/// (`ResourceId` here is a plain `ReadUInt32`, not a PackedDWORD). The fixed header
/// is therefore 8 + 4 + 4 + 4 + 1 + 4 + 4 = 29 bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct DddDataMessageData {
    pub dat_file: u64,
    pub resource_type: u32,
    pub resource_id: u32,
    pub iteration: u32,
    pub compression: u8,
    pub version: u32,
    pub data_size: u32,
    pub payload: DddDataPayload,
}

impl DddDataMessageData {
    /// Recompute `data_size` from the payload length + the compression skip
    /// (4 uncompressed, 8 compressed). Keeps the field idempotent across pack.
    fn computed_data_size(&self) -> u32 {
        match &self.payload {
            DddDataPayload::Uncompressed(data) => 4 + data.len() as u32,
            DddDataPayload::Compressed { data, .. } => 8 + data.len() as u32,
        }
    }
}

impl ProtocolUnpack for DddDataMessageData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        // Fixed header: DatFile (Int64, 8) + ResourceType (4) + ResourceId (4)
        // + Iteration (4) + Compression (byte, 1) + Version (4) + DataSize (4)
        // = 29 bytes.
        if *offset + 29 > data.len() {
            return None;
        }
        let dat_file = LittleEndian::read_u64(&data[*offset..*offset + 8]);
        let resource_type = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        let resource_id = LittleEndian::read_u32(&data[*offset + 12..*offset + 16]);
        let iteration = LittleEndian::read_u32(&data[*offset + 16..*offset + 20]);
        let compression = data[*offset + 20];
        let version = LittleEndian::read_u32(&data[*offset + 21..*offset + 25]);
        let data_size = LittleEndian::read_u32(&data[*offset + 25..*offset + 29]);
        *offset += 29;

        let payload = if compression == 0x01 {
            // Compressed: skip = 8 (DataSize DWORD + FileSize DWORD).
            if data_size < 8 {
                return None;
            }
            let payload_len = (data_size - 8) as usize;
            if *offset + 4 + payload_len > data.len() {
                return None;
            }
            let file_size = LittleEndian::read_u32(&data[*offset..*offset + 4]);
            *offset += 4;
            let bytes = data[*offset..*offset + payload_len].to_vec();
            *offset += payload_len;
            DddDataPayload::Compressed {
                file_size,
                data: bytes,
            }
        } else {
            // Uncompressed (0x00 or any non-0x01 discriminant): skip = 4 (DataSize DWORD).
            if data_size < 4 {
                return None;
            }
            let payload_len = (data_size - 4) as usize;
            if *offset + payload_len > data.len() {
                return None;
            }
            let bytes = data[*offset..*offset + payload_len].to_vec();
            *offset += payload_len;
            DddDataPayload::Uncompressed(bytes)
        };

        Some(DddDataMessageData {
            dat_file,
            resource_type,
            resource_id,
            iteration,
            compression,
            version,
            data_size,
            payload,
        })
    }
}

impl ProtocolPack for DddDataMessageData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u64::<LittleEndian>(self.dat_file).unwrap();
        buf.write_u32::<LittleEndian>(self.resource_type).unwrap();
        buf.write_u32::<LittleEndian>(self.resource_id).unwrap();
        buf.write_u32::<LittleEndian>(self.iteration).unwrap();
        buf.write_u8(self.compression).unwrap();
        buf.write_u32::<LittleEndian>(self.version).unwrap();
        // Recompute DataSize from the payload so pack is idempotent regardless
        // of the stored field (DataSize includes its own DWORD).
        buf.write_u32::<LittleEndian>(self.computed_data_size())
            .unwrap();
        match &self.payload {
            DddDataPayload::Uncompressed(data) => {
                buf.extend_from_slice(data);
            }
            DddDataPayload::Compressed { file_size, data } => {
                buf.write_u32::<LittleEndian>(*file_size).unwrap();
                buf.extend_from_slice(data);
            }
        }
    }
}

/// A single `DDDRevision` (protocol.xml:6565-6572) inside a `DddBeginDdd`.
/// `id_dat_file` is the raw `ulong`; the upper 32 bits are the DatFileType
/// (`id_dat_file >> 32`) — exposed via [`DddRevision::dat_file_type`], not split
/// on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct DddRevision {
    pub id_dat_file: u64,
    pub iteration: u32,
    pub ids_to_download: Vec<u32>,
    pub ids_to_purge: Vec<u32>,
}

impl DddRevision {
    /// The DatFileType encoded in the upper 32 bits of `id_dat_file`.
    pub fn dat_file_type(&self) -> u32 {
        (self.id_dat_file >> 32) as u32
    }
}

fn unpack_packable_list_u32(data: &[u8], offset: &mut usize) -> Option<Vec<u32>> {
    if *offset + 4 > data.len() {
        return None;
    }
    let count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
    *offset += 4;
    let mut out = Vec::with_capacity(capacity_hint(data, *offset, count as usize));
    for _ in 0..count {
        if *offset + 4 > data.len() {
            return None;
        }
        out.push(LittleEndian::read_u32(&data[*offset..*offset + 4]));
        *offset += 4;
    }
    Some(out)
}

fn pack_packable_list_u32(buf: &mut Vec<u8>, list: &[u32]) {
    buf.write_u32::<LittleEndian>(list.len() as u32).unwrap();
    for &v in list {
        buf.write_u32::<LittleEndian>(v).unwrap();
    }
}

impl ProtocolUnpack for DddRevision {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 12 > data.len() {
            return None;
        }
        let id_dat_file = LittleEndian::read_u64(&data[*offset..*offset + 8]);
        let iteration = LittleEndian::read_u32(&data[*offset + 8..*offset + 12]);
        *offset += 12;
        let ids_to_download = unpack_packable_list_u32(data, offset)?;
        let ids_to_purge = unpack_packable_list_u32(data, offset)?;
        Some(DddRevision {
            id_dat_file,
            iteration,
            ids_to_download,
            ids_to_purge,
        })
    }
}

impl ProtocolPack for DddRevision {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u64::<LittleEndian>(self.id_dat_file).unwrap();
        buf.write_u32::<LittleEndian>(self.iteration).unwrap();
        pack_packable_list_u32(buf, &self.ids_to_download);
        pack_packable_list_u32(buf, &self.ids_to_purge);
    }
}

/// `DddBeginDdd` (0xF7E7, S2C) payload. protocol.xml:8460-8462.
/// Fields: DataExpected (uint), Revisions (PackableList<DDDRevision>).
#[derive(Debug, Clone, PartialEq)]
pub struct DddBeginDddData {
    pub data_expected: u32,
    pub revisions: Vec<DddRevision>,
}

impl ProtocolUnpack for DddBeginDddData {
    fn unpack(data: &[u8], offset: &mut usize) -> Option<Self> {
        if *offset + 8 > data.len() {
            return None;
        }
        let data_expected = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let count = LittleEndian::read_u32(&data[*offset..*offset + 4]);
        *offset += 4;
        let mut revisions = Vec::with_capacity(capacity_hint(data, *offset, count as usize));
        for _ in 0..count {
            revisions.push(DddRevision::unpack(data, offset)?);
        }
        Some(DddBeginDddData {
            data_expected,
            revisions,
        })
    }
}

impl ProtocolPack for DddBeginDddData {
    fn pack(&self, buf: &mut Vec<u8>) {
        buf.write_u32::<LittleEndian>(self.data_expected).unwrap();
        buf.write_u32::<LittleEndian>(self.revisions.len() as u32)
            .unwrap();
        for rev in &self.revisions {
            rev.pack(buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures;
    use crate::test_helpers::assert_pack_unpack_parity;

    #[test]
    fn test_character_error_fixture() {
        let expected = CharacterErrorData {
            error_id: 0x80000001,
        };
        let mut buf = Vec::new();
        expected.pack(&mut buf);
        assert_eq!(buf.len(), 4);

        assert_pack_unpack_parity(&buf, &expected);
    }

    #[test]
    fn test_boot_account_fixture() {
        let expected = BootAccountData {
            reason: Some(" because you're mid".to_string()),
        };
        let mut buf = Vec::new();
        expected.pack(&mut buf);
        assert_pack_unpack_parity(&buf, &expected);

        let empty = BootAccountData { reason: None };
        let mut buf2 = Vec::new();
        empty.pack(&mut buf2);
        assert_pack_unpack_parity(&buf2, &empty);
    }

    #[test]
    fn test_ddd_interrogation_response_fixture() {
        let expected = DddInterrogationResponseData {
            language: 1,
            lists: vec![TaggedIterationList {
                dat_file_type: 1,
                dat_file_id: 1,
                list: MostlyConsecutiveIntSet {
                    iterations: 2,
                    values: vec![100, 101],
                },
            }],
        };
        let data = &test_fixtures::DDD_INTERROGATION_RESPONSE[4..];
        assert_pack_unpack_parity(data, &expected);
    }

    #[test]
    fn test_mostly_consecutive_int_set_fixture() {
        let expected = MostlyConsecutiveIntSet {
            iterations: 5,
            values: vec![1000, -5],
        };
        let data = vec![
            0x05, 0x00, 0x00, 0x00, // count
            0xE8, 0x03, 0x00, 0x00, // 1000
            0xFB, 0xFF, 0xFF, 0xFF, // -5
        ];
        assert_pack_unpack_parity(&data, &expected);
    }

    #[test]
    fn test_ddd_interrogation_fixture() {
        let expected = DddInterrogationData {
            servers_region: 1,
            name_rule_language: 2,
            product_id: 3,
            supported_languages: vec![1, 2],
        };
        let data = vec![
            0x01, 0x00, 0x00, 0x00, // servers_region = 1
            0x02, 0x00, 0x00, 0x00, // name_rule_language = 2
            0x03, 0x00, 0x00, 0x00, // product_id = 3
            0x02, 0x00, 0x00, 0x00, // supported_languages count = 2
            0x01, 0x00, 0x00, 0x00, // 1
            0x02, 0x00, 0x00, 0x00, // 2
        ];
        assert_pack_unpack_parity(&data, &expected);

        // Empty supported-languages list round-trips too.
        let empty = DddInterrogationData {
            servers_region: 0xAABBCCDD,
            name_rule_language: 0,
            product_id: 0,
            supported_languages: vec![],
        };
        let mut buf = Vec::new();
        empty.pack(&mut buf);
        assert_eq!(buf.len(), 16);
        assert_pack_unpack_parity(&buf, &empty);
    }

    #[test]
    fn test_ddd_request_data_message_fixture() {
        // resource_id is a DataId encoded as a PackedDWORD. 0x06000001 > 0x7FFF
        // so it uses the 4-byte high-bit form: lo = (id >> 16) | 0x8000 = 0x8600,
        // hi = id & 0xFFFF = 0x0001 (each written LE).
        let expected = DddRequestDataMessageData {
            resource_type: 0x01,
            resource_id: 0x0600_0001,
        };
        let data = vec![
            0x01, 0x00, 0x00, 0x00, // resource_type
            0x00, 0x86, // packed lo = 0x8600
            0x01, 0x00, // packed hi = 0x0001 -> resource_id = 0x06000001
        ];
        assert_pack_unpack_parity(&data, &expected);

        // Small DataId (<= 0x7FFF) uses the compact 2-byte PackedDWORD form.
        let small = DddRequestDataMessageData {
            resource_type: 0x02,
            resource_id: 0x1234,
        };
        let data_small = vec![
            0x02, 0x00, 0x00, 0x00, // resource_type
            0x34, 0x12, // packed resource_id = 0x1234 (2 bytes)
        ];
        assert_pack_unpack_parity(&data_small, &small);
    }

    #[test]
    fn test_ddd_error_message_fixture() {
        // resource_id is a PackedDWORD DataId. 0x0A000042 > 0x7FFF -> 4-byte form:
        // lo = (id >> 16) | 0x8000 = 0x8A00, hi = id & 0xFFFF = 0x0042 (LE).
        let expected = DddErrorMessageData {
            resource_type: 0x02,
            resource_id: 0x0A00_0042,
            r_error: 0x0000_0004,
        };
        let data = vec![
            0x02, 0x00, 0x00, 0x00, // resource_type
            0x00, 0x8A, // packed lo = 0x8A00
            0x42, 0x00, // packed hi = 0x0042 -> resource_id = 0x0A000042
            0x04, 0x00, 0x00, 0x00, // r_error
        ];
        assert_pack_unpack_parity(&data, &expected);

        // Small DataId uses the compact 2-byte form.
        let small = DddErrorMessageData {
            resource_type: 0x03,
            resource_id: 0x0042,
            r_error: 0x0000_0007,
        };
        let data_small = vec![
            0x03, 0x00, 0x00, 0x00, // resource_type
            0x42, 0x00, // packed resource_id = 0x0042 (2 bytes)
            0x07, 0x00, 0x00, 0x00, // r_error
        ];
        assert_pack_unpack_parity(&data_small, &small);
    }

    #[test]
    fn test_ddd_data_message_uncompressed_fixture() {
        // Uncompressed: DataSize = 4 (own DWORD) + payload.len().
        // Wire layout: DatFile (8) + ResourceType (4) + ResourceId (4) +
        // Iteration (4) + Compression (1) + Version (4) + DataSize (4) = 29
        // byte header, then payload.
        let payload = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01];
        let expected = DddDataMessageData {
            dat_file: 0x0000_0001_0000_0001,
            resource_type: 0x06,
            resource_id: 0x0600_0001,
            iteration: 7,
            compression: 0x00,
            version: 1,
            data_size: 4 + payload.len() as u32,
            payload: DddDataPayload::Uncompressed(payload.clone()),
        };
        let mut data = Vec::new();
        data.extend_from_slice(&0x0000_0001_0000_0001u64.to_le_bytes()); // dat_file (Int64)
        data.extend_from_slice(&0x06u32.to_le_bytes()); // resource_type
        data.extend_from_slice(&0x0600_0001u32.to_le_bytes()); // resource_id
        data.extend_from_slice(&7u32.to_le_bytes()); // iteration
        data.push(0x00); // compression = uncompressed (byte)
        data.extend_from_slice(&1u32.to_le_bytes()); // version
        data.extend_from_slice(&(4 + payload.len() as u32).to_le_bytes()); // data_size
        data.extend_from_slice(&payload); // payload bytes
        assert_pack_unpack_parity(&data, &expected);
    }

    #[test]
    fn test_ddd_data_message_compressed_fixture() {
        // Compressed: DataSize = 8 (own DWORD + FileSize DWORD) + payload.len().
        // Wire header is the same 29-byte fixed prefix as the uncompressed case
        // (DatFile is an 8-byte Int64, Compression a single byte), then FileSize
        // DWORD + payload.
        let payload = vec![0x11, 0x22, 0x33];
        let expected = DddDataMessageData {
            dat_file: 0x0000_0001_0000_0001,
            resource_type: 0x06,
            resource_id: 0x0600_0002,
            iteration: 3,
            compression: 0x01,
            version: 1,
            data_size: 8 + payload.len() as u32,
            payload: DddDataPayload::Compressed {
                file_size: 0x0000_1000,
                data: payload.clone(),
            },
        };
        let mut data = Vec::new();
        data.extend_from_slice(&0x0000_0001_0000_0001u64.to_le_bytes()); // dat_file (Int64)
        data.extend_from_slice(&0x06u32.to_le_bytes()); // resource_type
        data.extend_from_slice(&0x0600_0002u32.to_le_bytes()); // resource_id
        data.extend_from_slice(&3u32.to_le_bytes()); // iteration
        data.push(0x01); // compression = compressed (byte)
        data.extend_from_slice(&1u32.to_le_bytes()); // version
        data.extend_from_slice(&(8 + payload.len() as u32).to_le_bytes()); // data_size
        data.extend_from_slice(&0x0000_1000u32.to_le_bytes()); // file_size
        data.extend_from_slice(&payload); // payload bytes
        assert_pack_unpack_parity(&data, &expected);
    }

    #[test]
    fn test_ddd_data_message_data_size_underflow_guard() {
        // data_size < skip (4 uncompressed) must return None, not underflow-panic.
        let mut data = Vec::new();
        data.extend_from_slice(&0x01u64.to_le_bytes()); // dat_file (Int64)
        data.extend_from_slice(&0x06u32.to_le_bytes()); // resource_type
        data.extend_from_slice(&0x01u32.to_le_bytes()); // resource_id
        data.extend_from_slice(&0u32.to_le_bytes()); // iteration
        data.push(0x00); // compression = uncompressed (byte)
        data.extend_from_slice(&1u32.to_le_bytes()); // version
        data.extend_from_slice(&3u32.to_le_bytes()); // data_size = 3 (< 4 skip)
        let mut offset = 0;
        assert!(DddDataMessageData::unpack(&data, &mut offset).is_none());

        // Compressed with data_size < 8 must also return None.
        let mut data2 = Vec::new();
        data2.extend_from_slice(&0x01u64.to_le_bytes()); // dat_file (Int64)
        data2.extend_from_slice(&0x06u32.to_le_bytes()); // resource_type
        data2.extend_from_slice(&0x01u32.to_le_bytes()); // resource_id
        data2.extend_from_slice(&0u32.to_le_bytes()); // iteration
        data2.push(0x01); // compression = compressed (byte)
        data2.extend_from_slice(&1u32.to_le_bytes()); // version
        data2.extend_from_slice(&7u32.to_le_bytes()); // data_size = 7 (< 8 skip)
        data2.extend_from_slice(&0u32.to_le_bytes()); // file_size (present but unreadable)
        let mut offset2 = 0;
        assert!(DddDataMessageData::unpack(&data2, &mut offset2).is_none());
    }

    #[test]
    fn test_ddd_begin_ddd_fixture() {
        let expected = DddBeginDddData {
            data_expected: 0x2000,
            revisions: vec![
                DddRevision {
                    id_dat_file: 0x0000_0001_0000_0001,
                    iteration: 5,
                    ids_to_download: vec![0x0600_0001, 0x0600_0002],
                    ids_to_purge: vec![0x0600_0003],
                },
                DddRevision {
                    id_dat_file: 0x0000_0002_0000_0000,
                    iteration: 9,
                    ids_to_download: vec![],
                    ids_to_purge: vec![],
                },
            ],
        };
        let mut data = Vec::new();
        data.extend_from_slice(&0x2000u32.to_le_bytes()); // data_expected
        data.extend_from_slice(&2u32.to_le_bytes()); // revisions count
        // revision 0
        data.extend_from_slice(&0x0000_0001_0000_0001u64.to_le_bytes()); // id_dat_file
        data.extend_from_slice(&5u32.to_le_bytes()); // iteration
        data.extend_from_slice(&2u32.to_le_bytes()); // ids_to_download count
        data.extend_from_slice(&0x0600_0001u32.to_le_bytes());
        data.extend_from_slice(&0x0600_0002u32.to_le_bytes());
        data.extend_from_slice(&1u32.to_le_bytes()); // ids_to_purge count
        data.extend_from_slice(&0x0600_0003u32.to_le_bytes());
        // revision 1
        data.extend_from_slice(&0x0000_0002_0000_0000u64.to_le_bytes()); // id_dat_file
        data.extend_from_slice(&9u32.to_le_bytes()); // iteration
        data.extend_from_slice(&0u32.to_le_bytes()); // ids_to_download count
        data.extend_from_slice(&0u32.to_le_bytes()); // ids_to_purge count
        assert_pack_unpack_parity(&data, &expected);

        // dat_file_type helper reads the upper 32 bits.
        assert_eq!(expected.revisions[0].dat_file_type(), 1);
        assert_eq!(expected.revisions[1].dat_file_type(), 2);
    }
}
