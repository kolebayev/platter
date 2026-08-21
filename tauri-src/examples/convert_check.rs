//! Dev fixture: run the in-app lossless→ALAC conversion pipeline against
//! arbitrary files or folders from the command line, without launching the
//! app. Prints one "READY <path>" / "REJECTED <reason>" line per work item.
//!
//!   cargo run --example convert_check -- ~/Music/some-album [more paths…]
//!   cargo run --example convert_check -- --aac 256 ~/Music/some-album
//!   cargo run --example convert_check -- --mp3 320 ~/Music/some-album
//!
//! The target defaults to ALAC, which is what the import path asks for. The
//! lossy targets are there because they are the ones with an encoder in the
//! chain — the headroom pass only runs for those.
//!
//! Outputs land in $TMPDIR/convert-check (swept on every run).

use platter_tauri_lib::convert::{self, Rate, TargetFormat, TargetSpec};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let target = match args.first().map(String::as_str) {
        Some(flag @ ("--aac" | "--mp3")) => {
            let format = if flag == "--aac" {
                TargetFormat::Aac
            } else {
                TargetFormat::Mp3
            };
            let kbps: u32 = args
                .get(1)
                .and_then(|v| v.parse().ok())
                .expect("--aac/--mp3 takes a bitrate in kbps");
            args.drain(..2);
            TargetSpec {
                format,
                rate: Rate::Cbr(kbps),
                ipod_safe: true,
            }
        }
        _ => TargetSpec::alac(),
    };
    if args.is_empty() {
        eprintln!("usage: convert_check [--aac|--mp3 <kbps>] <path> [path ...]");
        std::process::exit(2);
    }
    target.validate().expect("target");

    let items = convert::scan(&args);
    if items.is_empty() {
        eprintln!("no importable audio found");
        std::process::exit(1);
    }

    let out_dir = std::env::temp_dir().join("convert-check");
    let _ = std::fs::remove_dir_all(&out_dir);
    let total = items.len();
    let results = convert::prepare_batch(
        &items,
        &out_dir,
        &target,
        &convert::ConvertControl::default(),
        &Verbose(total),
    );

    for (item, prepared) in items.iter().zip(&results) {
        match prepared {
            convert::Prepared::Ready(path) => println!("READY\t{}", path.display()),
            convert::Prepared::Rejected(reason) => {
                println!("REJECTED\t{}\t{reason}", item.display())
            }
            convert::Prepared::Cancelled => println!("CANCELLED\t{}", item.display()),
        }
    }
}

/// `ProgressOnly` swallows the log channel, and the headroom pass reports
/// itself through exactly that — a re-encode would otherwise look like the
/// batch had simply taken longer.
struct Verbose(usize);

impl convert::ConvertObserver for Verbose {
    fn log(&self, level: &'static str, file: Option<&str>, line: &str) {
        eprintln!("  [{level}] {}: {line}", file.unwrap_or("-"));
    }
    fn finished(&self, done: usize, name: &str) {
        eprintln!("[{done}/{}] {name}", self.0);
    }
}
