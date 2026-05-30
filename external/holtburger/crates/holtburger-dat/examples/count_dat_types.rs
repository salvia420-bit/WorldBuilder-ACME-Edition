use std::collections::HashMap;
use holtburger_dat::DatDatabase;

fn main() {
    let dat_path = "/home/wbterminal/ac_base_dats/client_portal.dat";
    
    match DatDatabase::new(dat_path) {
        Ok(db) => {
            let mut counts: HashMap<u8, usize> = HashMap::new();
            
            for file_id in db.files.keys() {
                let prefix = (file_id >> 24) as u8;
                *counts.entry(prefix).or_insert(0) += 1;
            }
            
            // Sort and print results
            let mut prefixes: Vec<_> = counts.iter().collect();
            prefixes.sort_by_key(|a| a.0);
            
            println!("File type counts in client_portal.dat:");
            println!("{:<8} {:<20} {:<10}", "Prefix", "Type Name", "Count");
            println!("{}", "=".repeat(40));
            
            for (&prefix, &count) in prefixes {
                let type_name = match prefix {
                    0x01 => "Model",
                    0x02 => "SetupModel",
                    0x03 => "Animation",
                    0x04 => "Palette",
                    0x05 => "SurfaceTexture",
                    0x06 | 0x07 => "Texture",
                    0x08 => "Surface",
                    0x09 => "MotionTable",
                    0x0A => "Audio",
                    0x0D => "EnvCell",
                    0x0E => "Table",
                    0x0F => "PaletteSet",
                    0x10 => "Clothing",
                    0x11 => "DegradeInfo",
                    0x12 => "Scene",
                    0x13 => "Region",
                    0x14 => "Keymap",
                    0x15 => "RenderTexture",
                    0x16 => "RenderMaterial",
                    0x17 => "MaterialModifier",
                    0x18 => "MaterialInstance",
                    0x19 => "RenderMesh",
                    0x20 => "SoundTable",
                    0x21 => "Layout",
                    0x22 => "EnumMapper",
                    0x23 => "StringTable",
                    0x24 => "StringTableString",
                    0x25 => "DataIDMapper",
                    0x26 => "ActionMap",
                    0x27 => "DualDataIDMapper",
                    0x30 => "CombatManeuverTable",
                    0x31 => "LanguageString",
                    0x32 => "ParticleEmitter",
                    0x33 => "PhysicsScript",
                    0x34 => "PhysicsScriptTable",
                    0x38 => "MutateFilter",
                    0x39 => "MasterProperty",
                    0x40 => "Font",
                    0x41 => "StringState",
                    0x42 => "BSPNodeType",
                    0x78 => "DatabaseProperties",
                    _ => "Unknown",
                };
                println!("0x{:02X}     {:<20} {:>10}", prefix, type_name, count);
            }
            
            // Summary for our targets
            println!("\n{}", "=".repeat(40));
            println!("TARGET TYPES:");
            println!("0x16 RenderMaterial:    {}", counts.get(&0x16).unwrap_or(&0));
            println!("0x17 MaterialModifier:  {}", counts.get(&0x17).unwrap_or(&0));
            println!("0x18 MaterialInstance:  {}", counts.get(&0x18).unwrap_or(&0));
            println!("\nBASELINE MATERIAL TYPES:");
            println!("0x05 SurfaceTexture:    {}", counts.get(&0x05).unwrap_or(&0));
            println!("0x06 Texture:           {}", counts.get(&0x06).unwrap_or(&0));
            println!("0x07 Texture (alt):     {}", counts.get(&0x07).unwrap_or(&0));
            println!("0x08 Surface:           {}", counts.get(&0x08).unwrap_or(&0));
        }
        Err(e) => {
            eprintln!("Failed to open DAT: {}", e);
            std::process::exit(1);
        }
    }
}
