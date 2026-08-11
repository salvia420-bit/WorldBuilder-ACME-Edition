//! `pcap2jsonl` — turn a captured retail Asheron's Call session into
//! movement/cast telemetry JSONL for the parity oracle.
//!
//! Capture side (on the Wine rig host, see `docs/reengineering/oracle/WINE-RIG.md`):
//!
//! ```sh
//! sudo tcpdump -i lo -n -s 0 -w retail.pcap 'udp port 9000 or udp port 9001'
//! ```
//!
//! Decode side:
//!
//! ```sh
//! pcap2jsonl --input retail.pcap --output retail.jsonl --summary
//! ```
//!
//! The output shares a schema with the holtburger `?moveTelemetry=1` dump so
//! `harness/oracle-diff.mjs` can align the two.

use std::io::Write;
use std::path::PathBuf;

use clap::Parser;
use holtburger_tools::oracle_pcap::{Options, decode_pcap};

#[derive(Parser, Debug)]
#[command(
    name = "pcap2jsonl",
    about = "Decode captured AC UDP traffic into movement/cast telemetry JSONL"
)]
struct Args {
    /// Capture file (classic pcap, e.g. from `tcpdump -w`).
    #[arg(short, long)]
    input: PathBuf,

    /// Output JSONL path; stdout when omitted.
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Emit a record for every decodable message, not just movement/cast.
    #[arg(long)]
    all: bool,

    /// Server UDP ports (repeatable). A datagram sourced from one of these is
    /// classified server->client.
    #[arg(long = "server-port", default_values_t = [9000u16, 9001u16])]
    server_ports: Vec<u16>,

    /// Keep absolute capture timestamps instead of re-basing to t=0.
    #[arg(long)]
    absolute_time: bool,

    /// Print a decode summary (counts + opcode histogram) to stderr.
    #[arg(long)]
    summary: bool,

    /// Exit non-zero if no telemetry records were produced. Use in scripts so
    /// a silently-empty capture fails loudly rather than yielding an empty
    /// parity report.
    #[arg(long)]
    require_records: bool,
}

fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let opts = Options {
        keep_all: args.all,
        server_ports: args.server_ports.clone(),
        relative_time: !args.absolute_time,
    };
    let (lines, summary) = decode_pcap(&args.input, &opts)?;

    match &args.output {
        Some(path) => {
            let mut f = std::fs::File::create(path)?;
            for l in &lines {
                writeln!(f, "{l}")?;
            }
        }
        None => {
            let stdout = std::io::stdout();
            let mut w = stdout.lock();
            for l in &lines {
                writeln!(w, "{l}")?;
            }
        }
    }

    if args.summary {
        eprintln!("{}", serde_json::to_string_pretty(&summary)?);
    }
    eprintln!(
        "pcap2jsonl: {} frames, {} AC datagrams, {} messages, {} telemetry records",
        summary.frames, summary.udp_datagrams, summary.messages, summary.records_emitted
    );
    if args.require_records && summary.records_emitted == 0 {
        anyhow::bail!(
            "no telemetry records decoded from {} — check the capture actually \
             covers UDP {:?} and that the session moved",
            args.input.display(),
            args.server_ports
        );
    }
    Ok(())
}
