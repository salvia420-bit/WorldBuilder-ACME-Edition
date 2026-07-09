//! dump_raw_record <dat_path> <id_hex> — write the RAW bytes of a DAT record to
//! stdout (binary). Used to feed known-good base-dat bytes to the deployed wasm
//! parser (parseMotionLinkForSwingBytes) to isolate parser-vs-served-bytes.
use holtburger_dat::DatDatabase;
use std::io::Write;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() != 2 {
        eprintln!("usage: dump_raw_record <dat_path> <id_hex>");
        std::process::exit(2);
    }
    let id = u32::from_str_radix(a[1].trim_start_matches("0x").trim_start_matches("0X"), 16)
        .expect("bad hex id");
    let dat = DatDatabase::new(&a[0]).expect("open dat");
    let bytes = dat.get_file(id).expect("get_file");
    std::io::stdout().write_all(&bytes).expect("write");
    eprintln!("wrote {} bytes for 0x{:08X}", bytes.len(), id);
}
