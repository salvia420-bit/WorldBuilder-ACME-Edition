use clap::Parser;
use holtburger_tools::boot_verify::{EXIT_NOT_FULLY_PACKABLE, format_report, verify_boot_pack};
use holtburger_tools::{ArchiveProfile, Dat2HbaOptions, DatInputSpec, ToolError, run};
use std::path::PathBuf;
use std::str::FromStr;

fn parse_hex_u32(value: &str) -> std::result::Result<u32, String> {
    let stripped = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    u32::from_str_radix(stripped, 16).map_err(|e| format!("invalid hex u32 {value:?}: {e}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InputArg {
    namespace: Option<String>,
    path: PathBuf,
}

impl FromStr for InputArg {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if let Some((namespace, path)) = value.split_once('=')
            && !namespace.is_empty()
            && !path.is_empty()
        {
            return Ok(Self {
                namespace: Some(namespace.to_string()),
                path: PathBuf::from(path),
            });
        }

        Ok(Self {
            namespace: None,
            path: PathBuf::from(value),
        })
    }
}

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Strips one or more Asheron's Call DAT files into a namespace-aware HBA archive"
)]
struct Args {
    /// Input DAT specs followed by the output HBA path. The last positional argument is always the output path.
    /// Use `namespace=path` for any input that needs an explicit namespace.
    #[arg(required = true, num_args = 2.., value_name = "[NAMESPACE=]DAT ... HBA")]
    paths: Vec<String>,

    /// Archive profile to emit: pruned, full, micro, or boot.
    /// Defaults to full.
    #[arg(long, value_enum, default_value_t = ArchiveProfile::Full)]
    profile: ArchiveProfile,

    /// Boot landblock when `--profile boot`. Hex (`0xA9B4`,
    /// default Holtburg). Ignored for other profiles.
    #[arg(long, value_parser = parse_hex_u32, default_value = "0xA9B4")]
    boot_landblock: u32,

    /// After writing the HBA, run the read-only boot-reachability
    /// walk against it (E4) and print whether `--boot-landblock` is
    /// *fully packable* — i.e. every GfxObj/Surface/SurfaceTexture/
    /// Texture/Palette its spawn-area placements reference is present.
    /// Exits non-zero (code 3) when NOT fully packable so CI can gate a
    /// generated boot pack. Additive: off by default, leaves the
    /// produced archive untouched.
    #[arg(long)]
    verify_boot_reachability: bool,
}

impl Args {
    fn into_options(self) -> Result<Dat2HbaOptions, ToolError> {
        let output = self.paths.last().map(PathBuf::from).ok_or_else(|| {
            ToolError::Validation(
                "dat2hba requires at least one input and one output path".to_string(),
            )
        })?;

        let inputs = self.paths[..self.paths.len() - 1]
            .iter()
            .map(|value| {
                InputArg::from_str(value)
                    .map(|input| DatInputSpec {
                        path: input.path,
                        namespace: input.namespace,
                    })
                    .map_err(ToolError::Validation)
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Dat2HbaOptions {
            inputs,
            output,
            profile: self.profile,
            boot_landblock: self.boot_landblock,
        })
    }
}

fn main() -> holtburger_tools::error::Result<()> {
    env_logger::init();
    let args = Args::parse();
    let verify_boot = args.verify_boot_reachability;
    let options = args.into_options()?;
    // Capture the bits the verification needs before `run` consumes
    // `options` (the boot-reachability flag is a binary-only concern, so
    // `Dat2HbaOptions` deliberately doesn't carry it).
    let output_path = options.output.clone();
    let boot_landblock = options.boot_landblock;

    println!("🎨 holtburger-tools: starting the glow-up...");
    run(options)?;
    println!("✨ Glow-up complete!");

    if verify_boot {
        let result = verify_boot_pack(&output_path, boot_landblock)?;
        // Report to stdout so it lands in CI logs alongside the
        // glow-up status; the headline line is machine-greppable.
        print!("{}", format_report(&result, boot_landblock));
        if !result.fully_packable {
            eprintln!(
                "dat2hba: boot landblock 0x{boot_landblock:04X} is NOT fully packable ({} dangling DID(s)) — boot pack gate FAILED",
                result.missing_dids.len()
            );
            std::process::exit(EXIT_NOT_FULLY_PACKABLE);
        }
        println!("dat2hba: boot landblock 0x{boot_landblock:04X} is fully packable (visual chain) ✅");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn args_default_profile_is_full() {
        let args = Args::try_parse_from(["dat2hba", "portal.dat", "portal.hba"])
            .expect("default args should parse");
        // Boot-reachability verification is opt-in (additive default).
        assert!(!args.verify_boot_reachability);
        let options = args
            .into_options()
            .expect("args should convert into options");

        assert_eq!(options.profile, ArchiveProfile::Full);
        assert_eq!(options.inputs.len(), 1);
        assert_eq!(options.inputs[0].path, PathBuf::from("portal.dat"));
        assert_eq!(options.inputs[0].namespace, None);
        assert_eq!(options.output, PathBuf::from("portal.hba"));
    }

    #[test]
    fn args_parse_verify_boot_reachability_flag() {
        let args = Args::try_parse_from([
            "dat2hba",
            "eor/cell=client_cell_1.dat",
            "eor/portal=client_portal.dat",
            "boot.hba",
            "--profile",
            "boot",
            "--boot-landblock",
            "0xA9B4",
            "--verify-boot-reachability",
        ])
        .expect("verify-boot-reachability args should parse");

        assert!(args.verify_boot_reachability);
        let options = args
            .into_options()
            .expect("args should convert into options");
        assert_eq!(options.profile, ArchiveProfile::Boot);
        assert_eq!(options.boot_landblock, 0xA9B4);
    }

    #[test]
    fn cli_help_lists_verify_boot_reachability_flag() {
        let help = Args::command().render_long_help().to_string();
        assert!(
            help.contains("--verify-boot-reachability"),
            "help should advertise the new flag, got:\n{help}"
        );
        assert!(help.contains("fully packable"));
    }

    #[test]
    fn args_parse_multiple_inputs_with_explicit_namespaces() {
        let args = Args::try_parse_from([
            "dat2hba",
            "eor/portal=client_portal.dat",
            "eor/cell=client_cell_1.dat",
            "bundle.hba",
            "--profile",
            "full",
        ])
        .expect("multi-input args should parse");
        let options = args
            .into_options()
            .expect("args should convert into options");

        assert_eq!(options.profile, ArchiveProfile::Full);
        assert_eq!(options.inputs.len(), 2);
        assert_eq!(options.inputs[0].namespace.as_deref(), Some("eor/portal"));
        assert_eq!(options.inputs[1].namespace.as_deref(), Some("eor/cell"));
        assert_eq!(options.output, PathBuf::from("bundle.hba"));
    }

    #[test]
    fn output_path_is_not_parsed_as_namespaced_input() {
        let args = Args::try_parse_from(["dat2hba", "portal.dat", "derived=test.hba"])
            .expect("args should parse");
        let options = args
            .into_options()
            .expect("args should convert into options");

        assert_eq!(options.inputs.len(), 1);
        assert_eq!(options.inputs[0].path, PathBuf::from("portal.dat"));
        assert_eq!(options.output, PathBuf::from("derived=test.hba"));
    }

    #[test]
    fn cli_help_describes_positional_io() {
        let help = Args::command().render_long_help().to_string();

        assert!(help.contains("The last positional argument is always the output path"));
        assert!(help.contains("namespace=path"));
        // Long-form help output. clap renders the doc comment on the
        // `boot` variant as a multi-line list; older variants stay
        // bare. Either format is acceptable — match the prefix that
        // tells us all four variants are exposed.
        assert!(
            help.contains("- pruned"),
            "help should list `pruned` as a possible profile value, got:\n{help}"
        );
        assert!(help.contains("- full"));
        assert!(help.contains("- micro"));
        assert!(help.contains("- boot"));
    }
}
