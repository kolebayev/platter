//! Lossless → iPod-ready ALAC conversion, ported from the `alac4ipod` zsh
//! engine so dropped FLAC/WAV/DSD/hi-res files land on the iPod as playable
//! Apple Lossless instead of being rejected.
//!
//! iPod Classic plays ALAC up to 16-bit / 48 kHz / 2 channels only. Anything
//! above that is downconverted (high-quality resample + TPDF dither, stereo
//! downmix); anything already within spec passes through losslessly. A
//! single-file album image with a .cue sheet is split into tagged tracks.
//! Lossy sources other than the formats the iPod plays natively (MP3/AAC)
//! are skipped — transcoding lossy → lossless would only waste space.
//!
//! ffmpeg/ffprobe come from Homebrew/MacPorts/PATH; nothing is bundled. When
//! they're missing, MP3/M4A behave exactly as before and everything else
//! fails with an install hint.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Formats the iPod plays natively — imported as-is, never probed.
pub const DIRECT_EXTENSIONS: [&str; 2] = ["mp3", "aac"];

/// Extensions worth probing. Lossy-only containers are excluded outright;
/// anything lossy that slips through (e.g. AAC inside .m4a) is sorted out by
/// the codec check after the probe.
pub const PROBE_EXTENSIONS: [&str; 17] = [
    "m4a", "alac", "flac", "wav", "wave", "aif", "aiff", "aifc", "ape", "wv", "tta", "dsf", "dff",
    "shn", "caf", "w64", "rf64",
];

/// Codecs we accept as "lossless enough to be worth an ALAC copy".
const LOSSLESS_CODECS: [&str; 14] = [
    "flac",
    "alac",
    "ape",
    "wavpack",
    "tta",
    "shorten",
    "als",
    "mlp",
    "truehd",
    "wmalossless",
    "dsd_lsbf",
    "dsd_msbf",
    "dsd_lsbf_planar",
    "dsd_msbf_planar",
];

/// iPod Classic shows small JPEG artwork most reliably; oversized or non-JPEG
/// art gets re-encoded to a <=600px JPEG when embedding. Above this edge
/// length even JPEG art is rescaled.
const ART_MAX_EDGE: u32 = 800;
const ART_NORM_OPTS: [&str; 8] = [
    "-c:v",
    "mjpeg",
    "-filter:v",
    "scale=w=min(iw\\,600):h=min(ih\\,600):force_original_aspect_ratio=decrease",
    "-pix_fmt",
    "yuvj420p",
    "-q:v",
    "3",
];

// --------------------------------------------------------------- target format

/// What the converter can produce. Everything except FLAC is on Apple's
/// published audio list for the Classic 6g/7g.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetFormat {
    Alac,
    Aac,
    Mp3,
    Aiff,
    Wav,
    /// Mac-only. Offered so the destination check has something to refuse.
    Flac,
}

impl TargetFormat {
    pub fn ext(self) -> &'static str {
        match self {
            Self::Alac | Self::Aac => "m4a",
            Self::Mp3 => "mp3",
            Self::Aiff => "aiff",
            Self::Wav => "wav",
            Self::Flac => "flac",
        }
    }

    pub fn ipod_playable(self) -> bool {
        !matches!(self, Self::Flac)
    }

    pub fn is_lossless(self) -> bool {
        !matches!(self, Self::Aac | Self::Mp3)
    }

    /// The wav muxer refuses any video stream outright — a mapped picture
    /// exits non-zero with a zero-byte output, so art is never attempted.
    pub fn can_embed_art(self) -> bool {
        !matches!(self, Self::Wav)
    }

    /// Encoders that want planar float. Rounding to s16 just to hand the
    /// encoder float again would add a dither noise floor for nothing.
    fn wants_float(self, aac_at: bool) -> bool {
        matches!(self, Self::Mp3) || (matches!(self, Self::Aac) && !aac_at)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Alac => "Apple Lossless",
            Self::Aac => "AAC",
            Self::Mp3 => "MP3",
            Self::Aiff => "AIFF",
            Self::Wav => "WAV",
            Self::Flac => "FLAC",
        }
    }
}

/// How much bitrate to spend. `Lossless` is the only legal value for a
/// lossless format; `TargetSpec::validate` enforces the pairing.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Rate {
    Lossless,
    /// Constant bitrate, kbps.
    Cbr(u32),
    /// Encoder VBR index, 0 = best. libmp3lame takes 0..=9, aac_at 0..=14.
    Vbr(u8),
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSpec {
    pub format: TargetFormat,
    pub rate: Rate,
    /// Clamp to 16-bit / <=48 kHz / stereo. Always true for an iPod
    /// destination; user-settable only when writing FLAC to a Mac folder.
    pub ipod_safe: bool,
}

impl TargetSpec {
    /// The target every pre-existing caller wants: what this app did before
    /// the converter existed.
    pub fn alac() -> Self {
        Self {
            format: TargetFormat::Alac,
            rate: Rate::Lossless,
            ipod_safe: true,
        }
    }

    /// Out-of-range VBR indices are not cosmetic: aac_at clamps silently to
    /// roughly 24 kbps, producing garbage that reports success.
    pub fn validate(&self) -> Result<(), String> {
        match (self.format.is_lossless(), self.rate) {
            (true, Rate::Lossless) => Ok(()),
            (false, Rate::Cbr(k)) if (96..=320).contains(&k) => Ok(()),
            (false, Rate::Vbr(q)) => match self.format {
                TargetFormat::Mp3 if q <= 9 => Ok(()),
                TargetFormat::Aac if q <= 14 => Ok(()),
                _ => Err("quality value out of range for this format".into()),
            },
            (true, _) => Err("lossless formats take no bitrate".into()),
            (false, _) => Err("this format needs a bitrate or quality".into()),
        }
    }
}

/// How long a helper process gets before it is assumed wedged. These are all
/// metadata-sized calls that finish in milliseconds; the limit exists so a
/// malformed file or a stuck binary cannot park a worker for the life of the
/// process. Long-running encodes are not covered here — `run_ffmpeg` registers
/// its child with `ConvertControl` and is cancelled that way instead.
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);

/// The headroom check decodes a whole file rather than reading a header, so it
/// cannot share `TOOL_TIMEOUT`. Decoding runs at a few hundred times realtime;
/// this covers a multi-hour set on a slow machine and still bounds a wedged
/// binary.
const MEASURE_TIMEOUT: Duration = Duration::from_secs(300);

/// `Command::output` with a deadline. std has no timed wait, so a watchdog
/// thread SIGKILLs the child if it outstays the limit and the normal
/// `wait_with_output` then returns as it would for any killed process. Reading
/// through `wait_with_output` also keeps both pipes drained, which a
/// poll-and-kill loop would not — a child that filled its stdout buffer would
/// deadlock against us instead of timing out.
fn output_with_timeout(cmd: &mut Command, limit: Duration) -> std::io::Result<Output> {
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id() as i32;
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog = finished.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if watchdog.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !watchdog.load(Ordering::Relaxed) {
            // Safe: the pid is our own child and has not been reaped yet —
            // `finished` is only set after wait_with_output returns.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    });
    let out = child.wait_with_output();
    finished.store(true, Ordering::Relaxed);
    out
}

/// What the ffmpeg we resolved was actually built with. One `-buildconf` pass
/// answers every question we have about it; this used to be spawned twice,
/// once for the encoders and again for the resampler, parsing the same output.
pub struct Encoders {
    /// AudioToolbox AAC — better than the native encoder at every bitrate.
    pub aac_at: bool,
    /// ffmpeg ships no native MP3 encoder; without lame the option is dead.
    pub lame: bool,
    /// Homebrew's ffmpeg is often built without libsoxr.
    pub soxr: bool,
}

pub fn encoders() -> &'static Encoders {
    static CACHE: OnceLock<Encoders> = OnceLock::new();
    CACHE.get_or_init(|| {
        let conf = tools()
            .and_then(|t| {
                output_with_timeout(
                    Command::new(&t.ffmpeg).args(["-hide_banner", "-buildconf"]),
                    TOOL_TIMEOUT,
                )
                .ok()
            })
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        Encoders {
            aac_at: conf.contains("--enable-audiotoolbox"),
            lame: conf.contains("--enable-libmp3lame"),
            soxr: conf.contains("--enable-libsoxr"),
        }
    })
}

// ------------------------------------------------------------------ tool paths

/// The sidecar staged next to the executable: `Contents/MacOS/<name>` in a
/// bundle, `target/<profile>/<name>` under `cargo run` — tauri-build stages it
/// into the cargo target dir, so one exe-relative lookup covers both.
///
/// The `..` candidate is for `cargo test`, whose binaries live one level down
/// in `target/<profile>/deps/`. Without it every ffmpeg-dependent test would
/// silently fall through to the system binary and the bundled path would never
/// be exercised.
fn bundled_tool(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [dir.join(name), dir.join("..").join(name)]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn find_tool(name: &str) -> Option<PathBuf> {
    if let Some(bundled) = bundled_tool(name) {
        return Some(bundled);
    }
    // Second chance: a developer building without staged binaries, or a user
    // who would rather Platter used their own ffmpeg.
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
        let p = Path::new(prefix).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // The app is launched from Finder with a minimal PATH, so `which` through
    // the user's shell profile is the last resort, not the first.
    let out = output_with_timeout(Command::new("/usr/bin/which").arg(name), TOOL_TIMEOUT).ok()?;
    if out.status.success() {
        let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// Both tools, discovered once per process. None when either is missing.
pub fn tools() -> Option<&'static Tools> {
    static TOOLS: OnceLock<Option<Tools>> = OnceLock::new();
    TOOLS
        .get_or_init(|| {
            Some(Tools {
                ffmpeg: find_tool("ffmpeg")?,
                ffprobe: find_tool("ffprobe")?,
            })
        })
        .as_ref()
}

pub const FFMPEG_MISSING: &str =
    "needs conversion to Apple Lossless, but ffmpeg isn't installed (brew install ffmpeg)";

/// Without libsoxr, fall back to swr tuned well past its defaults
/// (filter_size 32 -> 512). Reads the shared `-buildconf` probe.
fn resampler_args() -> &'static str {
    if encoders().soxr {
        "resampler=soxr:precision=28"
    } else {
        "resampler=swr:filter_size=512:phase_shift=12:cutoff=0.95:exact_rational=1"
    }
}

// --------------------------------------------------------------- small helpers

pub fn lower_ext(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_direct_ext(path: &Path) -> bool {
    DIRECT_EXTENSIONS.contains(&lower_ext(path).as_str())
}

fn is_probe_ext(path: &Path) -> bool {
    PROBE_EXTENSIONS.contains(&lower_ext(path).as_str())
}

pub fn is_audio_ext(path: &Path) -> bool {
    is_direct_ext(path) || is_probe_ext(path)
}

/// Whether a staged import path may need conversion before libgpod sees it
/// (i.e. anything that isn't a natively-playable MP3/AAC).
pub fn needs_prepare(path: &Path) -> bool {
    is_probe_ext(path)
}

/// Strip characters that confuse FAT-formatted iPods and path joins.
fn sanitize(s: &str) -> String {
    s.replace(['/', ':'], "-")
}

/// iPod Classic tops out at 48 kHz. Stay inside the source's own clock family
/// so resampling is a clean integer ratio: 88.2/176.4/352.8 -> 44.1,
/// 96/192 -> 48.
pub fn target_rate(rate: u32) -> u32 {
    if rate == 0 {
        return 44100;
    }
    if rate.is_multiple_of(44100) {
        return 44100;
    }
    if rate.is_multiple_of(48000) {
        return 48000;
    }
    if rate <= 44100 {
        44100
    } else {
        48000
    }
}

fn bits_from_sample_fmt(fmt: &str) -> u32 {
    match fmt.trim_end_matches('p') {
        "u8" => 8,
        "s16" => 16,
        "s32" | "flt" => 32,
        "dbl" => 64,
        f if f.starts_with("dsd") => 1,
        _ => 0,
    }
}

// ------------------------------------------------------------------- probing

#[derive(Clone, Default)]
pub struct MediaProbe {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bits: u32,
    pub sample_fmt: String,
    pub art_codec: Option<String>,
    pub art_w: u32,
    pub art_h: u32,
    /// Seconds. 0 means "unknown", never "empty" — some containers report no
    /// duration at all, and a size estimate must exclude those rather than
    /// count them as free.
    pub duration_s: f64,
    /// Container bitrate in bits/s; 0 when absent.
    pub bit_rate: u64,
    /// Source file size in bytes, as ffprobe saw it.
    pub file_bytes: u64,
    /// True only when ffprobe actually reported `bits_per_raw_sample`. When
    /// false, `bits` was inferred from the sample format, which cannot
    /// distinguish 24-bit-in-s32 from true 32-bit — a 33% error in a raw-PCM
    /// size estimate. Classification (`needs_work`) is unaffected either way.
    pub bits_known: bool,
}

impl MediaProbe {
    fn is_dsd(&self) -> bool {
        self.codec.starts_with("dsd_")
    }

    fn is_lossless(&self) -> bool {
        self.codec.starts_with("pcm_") || LOSSLESS_CODECS.contains(&self.codec.as_str())
    }

    /// Bit depth to bill for when sizing raw PCM. 24-bit sources decode as
    /// `s32` with no `bits_per_raw_sample`, and billing them at 32 overstates
    /// a WAV/AIFF estimate by a third.
    pub fn effective_bits(&self) -> u32 {
        if self.bits_known && self.bits > 0 {
            return self.bits;
        }
        match self.sample_fmt.trim_end_matches('p') {
            "s32" | "flt" | "dbl" => 24,
            _ if self.bits > 0 => self.bits,
            _ => 16,
        }
    }

    /// Whether the audio needs resampling/dithering/downmixing to fit the
    /// iPod's 16-bit / <=48 kHz / stereo ceiling.
    fn needs_work(&self) -> bool {
        target_rate(self.sample_rate) != self.sample_rate
            || self.bits != 16
            || !self.sample_fmt.starts_with("s16")
            || self.channels > 2
            || self.is_dsd()
    }
}

/// One ffprobe pass for the audio stream AND any artwork stream — also serves
/// standalone images, which carry only a video stream. First stream of each
/// type wins. None when ffprobe finds no streams at all; audio callers must
/// additionally check `codec` is non-empty.
pub fn probe_media(ffprobe: &Path, src: &Path) -> Option<MediaProbe> {
    let out = output_with_timeout(
        Command::new(ffprobe)
            .args([
            "-v",
            "error",
            "-show_entries",
            // The format section is a required fallback, not a nicety: FLAC
            // omits stream.bit_rate entirely and several containers omit
            // stream.duration. Both sections come back from this one pass.
            "stream=codec_name,codec_type,width,height,sample_fmt,sample_rate,channels,bits_per_raw_sample,duration,bit_rate:format=duration,size,bit_rate",
            "-of",
            "json",
        ])
            .arg("--")
            .arg(src),
        TOOL_TIMEOUT,
    )
    .ok()?;
    let json: Value = serde_json::from_slice(&out.stdout).ok()?;
    let mut probe = MediaProbe::default();
    // ffprobe reports some numerics as strings ("44100") and some as numbers
    // depending on the field — accept both. `size` needs the full 64 bits: a
    // DSD album image or a long WAV passes 4 GB and would wrap in a u32.
    let num64 = |v: &Value| -> u64 {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0)
    };
    let num = |v: &Value| -> u32 { num64(v).min(u32::MAX as u64) as u32 };
    for stream in json["streams"].as_array()? {
        let ctype = stream["codec_type"].as_str().unwrap_or("");
        let codec = stream["codec_name"].as_str().unwrap_or("").to_string();
        if ctype == "audio" && probe.codec.is_empty() {
            probe.codec = codec;
            probe.sample_rate = num(&stream["sample_rate"]);
            probe.channels = num(&stream["channels"]);
            probe.bits = num(&stream["bits_per_raw_sample"]);
            probe.bits_known = probe.bits > 0;
            probe.sample_fmt = stream["sample_fmt"].as_str().unwrap_or("").to_string();
            probe.duration_s = secs(&stream["duration"]);
            probe.bit_rate = num64(&stream["bit_rate"]);
        } else if ctype == "video" && probe.art_codec.is_none() {
            probe.art_codec = Some(codec);
            probe.art_w = num(&stream["width"]);
            probe.art_h = num(&stream["height"]);
        }
    }
    let format = &json["format"];
    if probe.duration_s <= 0.0 {
        probe.duration_s = secs(&format["duration"]);
    }
    if probe.bit_rate == 0 {
        probe.bit_rate = num64(&format["bit_rate"]);
    }
    probe.file_bytes = num64(&format["size"]);
    if probe.bits == 0 {
        probe.bits = bits_from_sample_fmt(&probe.sample_fmt);
    }
    if probe.codec.is_empty() && probe.art_codec.is_none() {
        None
    } else {
        Some(probe)
    }
}

/// ffprobe writes durations as decimal strings ("212.386667") and sometimes as
/// the literal "N/A". Anything unparseable is 0, meaning unknown.
fn secs(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .filter(|d: &f64| d.is_finite() && *d > 0.0)
        .unwrap_or(0.0)
}

// ------------------------------------------------------------------ cue sheets

#[derive(Clone)]
pub struct CueMeta {
    pub start: f64,
    /// None for the last track — encode to end of file.
    pub end: Option<f64>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub track_num: u32,
    pub track_total: u32,
    pub date: String,
    pub genre: String,
    pub album_artist: String,
}

struct CueSheet {
    audio_file: PathBuf,
    tracks: Vec<CueMeta>,
}

/// Cue text arrives in whatever encoding the ripper used. Try UTF-8 (with or
/// without BOM), then cp1251 (RuTracker), then latin-1 as the catch-all.
fn decode_cue_bytes(raw: &[u8]) -> String {
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(raw);
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    let (s, _, malformed) = encoding_rs::WINDOWS_1251.decode(raw);
    if !malformed && !s.contains('\u{FFFD}') {
        return s.into_owned();
    }
    raw.iter().map(|&b| b as char).collect()
}

/// `TITLE "Foo"` / `TITLE Foo` — strip one optional pair of double quotes.
fn cue_value(rest: &str) -> String {
    let rest = rest.trim();
    rest.strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(rest)
        .to_string()
}

/// `FILE "name" WAVE` — the path is everything between the outer quotes, or
/// the bare second token.
fn cue_file_value(rest: &str) -> Option<String> {
    let rest = rest.trim();
    if let Some(after) = rest.strip_prefix('"') {
        let close = after.rfind('"')?;
        return Some(after[..close].to_string());
    }
    rest.split_whitespace().next().map(str::to_string)
}

/// Parse a .cue file. Fails (None) unless it references exactly one existing
/// audio file and holds >=2 indexed tracks — anything else is a per-track cue
/// that the normal file conversion already handles.
fn parse_cue(path: &Path) -> Option<CueSheet> {
    let raw = std::fs::read(path).ok()?;
    let text = decode_cue_bytes(&raw);

    struct RawTrack {
        num: u32,
        title: String,
        performer: String,
        start: Option<f64>,
    }
    let mut files: Vec<String> = Vec::new();
    let mut tracks: Vec<RawTrack> = Vec::new();
    let mut album = String::new();
    let mut album_performer = String::new();
    let mut date = String::new();
    let mut genre = String::new();
    let mut in_track = false;

    for line in text.lines() {
        let s = line.trim();
        let upper = s.to_uppercase();
        if upper.starts_with("FILE ") {
            if let Some(f) = cue_file_value(&s[5..]) {
                files.push(f);
            }
            in_track = false;
        } else if upper.starts_with("TRACK ") {
            let mut parts = s[6..].split_whitespace();
            let num: u32 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            if parts
                .next()
                .is_some_and(|t| t.eq_ignore_ascii_case("AUDIO"))
            {
                tracks.push(RawTrack {
                    num,
                    title: String::new(),
                    performer: String::new(),
                    start: None,
                });
                in_track = true;
            } else {
                in_track = false;
            }
        } else if upper.starts_with("TITLE") {
            let v = cue_value(&s[5..]);
            match (in_track, tracks.last_mut()) {
                (true, Some(t)) => t.title = v,
                _ => album = v,
            }
        } else if upper.starts_with("PERFORMER") {
            let v = cue_value(&s[9..]);
            match (in_track, tracks.last_mut()) {
                (true, Some(t)) => t.performer = v,
                _ => album_performer = v,
            }
        } else if upper.starts_with("INDEX") {
            let mut toks = s[5..].split_whitespace();
            if toks.next() == Some("01") && in_track {
                if let (Some(stamp), Some(t)) = (toks.next(), tracks.last_mut()) {
                    let mut nums = stamp.split(':').filter_map(|n| n.parse::<f64>().ok());
                    if let (Some(mm), Some(ss), Some(ff)) = (nums.next(), nums.next(), nums.next())
                    {
                        t.start = Some(mm * 60.0 + ss + ff / 75.0);
                    }
                }
            }
        } else if upper.starts_with("REM DATE") {
            date = cue_value(&s[8..]);
        } else if upper.starts_with("REM GENRE") {
            genre = cue_value(&s[9..]);
        }
    }

    let tracks: Vec<RawTrack> = tracks.into_iter().filter(|t| t.start.is_some()).collect();
    if files.len() != 1 || tracks.len() < 2 {
        return None;
    }

    let dir = path.parent()?;
    let named = dir.join(files[0].replace('\\', "/"));
    let audio_file = if named.is_file() {
        named
    } else {
        // Rips renamed after the fact: match the referenced basename
        // case-insensitively within the cue's own directory.
        let want = Path::new(&files[0].replace('\\', "/"))
            .file_name()?
            .to_string_lossy()
            .to_lowercase();
        std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.is_file()
                    && p.file_name()
                        .is_some_and(|n| n.to_string_lossy().to_lowercase() == want)
            })?
    };

    let total = tracks.len() as u32;
    let metas = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| CueMeta {
            start: t.start.unwrap(),
            end: tracks.get(i + 1).and_then(|n| n.start),
            title: if t.title.is_empty() {
                format!("Track {}", t.num)
            } else {
                t.title.clone()
            },
            artist: if t.performer.is_empty() {
                album_performer.clone()
            } else {
                t.performer.clone()
            },
            album: album.clone(),
            track_num: t.num,
            track_total: total,
            date: date.clone(),
            genre: genre.clone(),
            album_artist: album_performer.clone(),
        })
        .collect();

    Some(CueSheet {
        audio_file,
        tracks: metas,
    })
}

// ------------------------------------------------------------------ scanning

/// One dropped file to prepare: either import `src` as-is, or convert it to
/// `out_dir/<dst_stem>.<target ext>` first (always the latter for cue-split
/// tracks). `dst_stem` carries a per-item subdirectory ("3/Song") so identical
/// stems from different album folders can't collide in one output dir, while
/// the file stem itself stays clean for the tag reader's filename fallback
/// title.
///
/// It deliberately carries **no extension**: the target format owns that, and
/// a stem that already ended in ".m4a" is how you end up writing MP3 bytes
/// into a file libgpod then copies to the device with an `M4A ` marker — an
/// unplayable track with no error anywhere in the chain.
pub struct WorkItem {
    pub src: PathBuf,
    pub dst_stem: String,
    pub cue: Option<CueMeta>,
    /// Filled in by the converter's queue, which probes on add. None means
    /// "probe it yourself", which is what the drag-and-drop import path does.
    pub probe: Option<MediaProbe>,
}

impl WorkItem {
    pub fn display(&self) -> String {
        match &self.cue {
            Some(_) => Path::new(&self.dst_stem)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.dst_stem.clone()),
            None => self
                .src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.src.display().to_string()),
        }
    }
}

struct Scanner {
    items: Vec<WorkItem>,
    /// (source path, cue track number) — selecting a cue-split file together
    /// with its folder (or its cue) yields identical records; first one wins.
    seen: HashSet<(PathBuf, u32)>,
}

impl Scanner {
    fn push_audio(&mut self, src: &Path) {
        if !self.seen.insert((src.to_path_buf(), 0)) {
            return;
        }
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "track".into());
        self.items.push(WorkItem {
            src: src.to_path_buf(),
            dst_stem: format!("{}/{}", self.items.len(), sanitize(&stem)),
            cue: None,
            probe: None,
        });
    }

    fn push_cue_tracks(&mut self, sheet: CueSheet) {
        for meta in sheet.tracks {
            if !self.seen.insert((sheet.audio_file.clone(), meta.track_num)) {
                continue;
            }
            self.items.push(WorkItem {
                src: sheet.audio_file.clone(),
                dst_stem: format!(
                    "{}/{:02} {}",
                    self.items.len(),
                    meta.track_num,
                    sanitize(&meta.title)
                ),
                cue: Some(meta),
                probe: None,
            });
        }
    }

    fn scan_dir(&mut self, dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();

        // Cue-driven album images first: their audio file is excluded from
        // the normal per-file pass and split into tagged tracks instead.
        let mut excluded: HashSet<String> = HashSet::new();
        for p in paths.iter().filter(|p| p.is_file()) {
            if lower_ext(p) != "cue" {
                continue;
            }
            let Some(sheet) = parse_cue(p) else {
                continue;
            };
            let key = sheet
                .audio_file
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            // second cue for the same image — first one wins
            if !excluded.insert(key) {
                continue;
            }
            self.push_cue_tracks(sheet);
        }

        for p in &paths {
            if p.is_dir() {
                self.scan_dir(p);
            } else if p.is_file()
                && is_audio_ext(p)
                && !excluded.contains(
                    &p.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase(),
                )
            {
                self.push_audio(p);
            }
        }
    }

    /// A file picked directly. Selecting the .cue, or an audio file that a
    /// sibling cue references, yields tagged tracks instead of one giant m4a.
    fn scan_single(&mut self, file: &Path) {
        if lower_ext(file) == "cue" {
            if let Some(sheet) = parse_cue(file) {
                self.push_cue_tracks(sheet);
            }
            return;
        }
        if !is_audio_ext(file) {
            return;
        }
        if is_probe_ext(file) {
            if let Some(dir) = file.parent() {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for p in entries.flatten().map(|e| e.path()) {
                        if lower_ext(&p) != "cue" {
                            continue;
                        }
                        let Some(sheet) = parse_cue(&p) else {
                            continue;
                        };
                        let same = sheet
                            .audio_file
                            .canonicalize()
                            .ok()
                            .zip(file.canonicalize().ok())
                            .is_some_and(|(a, b)| a == b);
                        if same {
                            self.push_cue_tracks(sheet);
                            return;
                        }
                    }
                }
            }
        }
        self.push_audio(file);
    }
}

/// Expand the dropped selection into work items. Directories recurse; cue
/// sheets split; duplicates collapse.
pub fn scan(paths: &[String]) -> Vec<WorkItem> {
    let mut scanner = Scanner {
        items: Vec::new(),
        seen: HashSet::new(),
    };
    for p in paths {
        let path = PathBuf::from(p.trim_end_matches('/'));
        if path.is_dir() {
            scanner.scan_dir(&path);
        } else if path.is_file() {
            scanner.scan_single(&path);
        }
    }
    scanner.items
}

// ------------------------------------------------------------------ conversion

pub enum Prepared {
    /// Import this path — the original file, or a converted temp file.
    Ready(PathBuf),
    /// Not iPod material (lossy source in a lossless container, unreadable…).
    Rejected(String),
    /// The job was cancelled before this item ran, or while it ran. Distinct
    /// from Rejected on purpose — a cancelled item is not a failure and must
    /// not be counted or reported as one.
    Cancelled,
}

/// Best folder image to embed when the track carries no artwork of its own.
fn folder_cover(dir: &Path) -> Option<PathBuf> {
    const PRIO: [&str; 6] = ["cover", "folder", "front", "albumart", "album", "artwork"];
    const DEMOTED: [&str; 8] = [
        "back", "insert", "inside", "rear", "matrix", "label", "booklet", "obi",
    ];
    let mut best: Option<(u32, PathBuf)> = None;
    for p in std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()) {
        if !p.is_file() || !matches!(lower_ext(&p).as_str(), "jpg" | "jpeg" | "png") {
            continue;
        }
        let base = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mut rank = 50;
        for (i, prefix) in PRIO.iter().enumerate() {
            if base.starts_with(prefix) {
                rank = i as u32 + 1;
                break;
            }
        }
        // Vinyl/CD scan sets name every side; anything that isn't the front
        // should lose to a plain unlabeled scan.
        if rank == 50 && DEMOTED.iter().any(|d| base.contains(d)) {
            rank = 90;
        }
        if best.as_ref().is_none_or(|(r, _)| rank < *r) {
            best = Some((rank, p));
        }
    }
    best.map(|(_, p)| p)
}

/// A directory's chosen cover and whether it needs normalization — the two
/// things convert_one otherwise worked out per track with a read_dir plus an
/// ffprobe spawn on the same cover.jpg, multiplied by every track of an album.
#[derive(Clone)]
struct CoverPick {
    path: PathBuf,
    norm: bool,
}

/// Per-run cache of folder-cover decisions and normalized covers: cue splits
/// would otherwise decode and rescale the same multi-hundred-MB scan for
/// every track of the album. Keyed by cover path (normalization) and source
/// directory (picking); None caches a miss/failed normalization.
pub struct ArtCache {
    dir: PathBuf,
    entries: Mutex<HashMap<PathBuf, Option<PathBuf>>>,
    picks: Mutex<HashMap<PathBuf, Option<CoverPick>>>,
    counter: AtomicUsize,
}

impl ArtCache {
    fn new(dir: &Path) -> Self {
        ArtCache {
            dir: dir.join("artcache"),
            entries: Mutex::new(HashMap::new()),
            picks: Mutex::new(HashMap::new()),
            counter: AtomicUsize::new(0),
        }
    }

    /// The folder cover for tracks living in `dir`, resolved once per batch.
    fn cover_in(&self, ffprobe: &Path, dir: &Path) -> Option<CoverPick> {
        if let Some(hit) = self.picks.lock().unwrap().get(dir) {
            return hit.clone();
        }
        let pick = folder_cover(dir).map(|cover| {
            let ext_norm = !matches!(lower_ext(&cover).as_str(), "jpg" | "jpeg");
            let size_norm = probe_media(ffprobe, &cover)
                .map(|p| p.art_w > ART_MAX_EDGE || p.art_h > ART_MAX_EDGE)
                .unwrap_or(false);
            CoverPick {
                path: cover,
                norm: ext_norm || size_norm,
            }
        });
        // Concurrent workers may race to fill the same album — both answers
        // are identical, last insert wins.
        self.picks
            .lock()
            .unwrap()
            .insert(dir.to_path_buf(), pick.clone());
        pick
    }

    fn normalized(&self, ffmpeg: &Path, src: &Path) -> Option<PathBuf> {
        if let Some(hit) = self.entries.lock().unwrap().get(src) {
            return hit.clone();
        }
        std::fs::create_dir_all(&self.dir).ok()?;
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let out = self.dir.join(format!("cover-{n}.jpg"));
        let ok = Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-i"])
            .arg(src)
            .args(ART_NORM_OPTS)
            .args(["-frames:v", "1"])
            .arg(&out)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let result = if ok { Some(out) } else { None };
        // Concurrent workers may race to build the same entry — both produce
        // a valid file, last insert wins.
        self.entries
            .lock()
            .unwrap()
            .insert(src.to_path_buf(), result.clone());
        result
    }
}

enum ArtPlan {
    None,
    /// Art travels inside the source file (input 0, or a second un-seeked
    /// copy of the source when trimming).
    Embedded {
        norm: bool,
    },
    /// Art comes from a separate image file fed as an extra input.
    File {
        path: PathBuf,
        norm: bool,
    },
}

/// Codec selection and quality, as argv fragments.
fn encoder_args(target: &TargetSpec) -> Vec<String> {
    let s = |v: &str| v.to_string();
    match target.format {
        TargetFormat::Alac => vec![s("-c:a"), s("alac"), s("-sample_fmt"), s("s16p")],
        TargetFormat::Aac => {
            // aac_at is AudioToolbox's encoder — audibly better than the
            // native one at the same bitrate, and present on every Mac.
            let mut args = if encoders().aac_at {
                match target.rate {
                    Rate::Vbr(_) => vec![s("-c:a"), s("aac_at"), s("-aac_at_mode"), s("vbr")],
                    _ => vec![s("-c:a"), s("aac_at"), s("-aac_at_mode"), s("cbr")],
                }
            } else {
                vec![s("-c:a"), s("aac")]
            };
            match target.rate {
                Rate::Cbr(kbps) => args.extend([s("-b:a"), format!("{kbps}k")]),
                // The native encoder has no comparable VBR index; fall back to
                // a bitrate rather than silently ignoring the setting.
                Rate::Vbr(q) if encoders().aac_at => args.extend([s("-q:a"), q.to_string()]),
                Rate::Vbr(q) => args.extend([s("-b:a"), format!("{}k", 256 - (q as u32 * 16))]),
                Rate::Lossless => {}
            }
            args
        }
        TargetFormat::Mp3 => {
            let mut args = vec![s("-c:a"), s("libmp3lame")];
            match target.rate {
                Rate::Cbr(kbps) => args.extend([s("-b:a"), format!("{kbps}k")]),
                Rate::Vbr(q) => args.extend([s("-q:a"), q.to_string()]),
                Rate::Lossless => {}
            }
            args
        }
        // AIFF is big-endian PCM, WAV little-endian. Getting these the wrong
        // way round produces a file that plays as white noise.
        TargetFormat::Aiff => vec![s("-c:a"), s("pcm_s16be")],
        TargetFormat::Wav => vec![s("-c:a"), s("pcm_s16le")],
        TargetFormat::Flac => {
            let mut args = vec![s("-c:a"), s("flac"), s("-compression_level"), s("5")];
            if target.ipod_safe {
                args.extend([s("-sample_fmt"), s("s16")]);
            }
            args
        }
    }
}

/// Container flags. The muxer is named explicitly for every format: ffmpeg
/// otherwise guesses from the output extension, which is exactly the coupling
/// that lets a rename produce a mislabelled file.
fn muxer_args(format: TargetFormat) -> Vec<String> {
    let s = |v: &str| v.to_string();
    match format {
        // `ipod` is the MP4 variant the device expects; it rejects mp3 outright.
        TargetFormat::Alac | TargetFormat::Aac => {
            vec![s("-movflags"), s("+faststart"), s("-f"), s("ipod")]
        }
        // v2.3 rather than ffmpeg's v2.4 default — more readers handle it.
        // -write_xing carries LAME's gapless delay/padding.
        TargetFormat::Mp3 => vec![
            s("-id3v2_version"),
            s("3"),
            s("-write_id3v1"),
            s("1"),
            s("-write_xing"),
            s("1"),
            s("-f"),
            s("mp3"),
        ],
        // Without -write_id3v2 the aiff muxer exits 0 having silently dropped
        // the cover art and every tag but the title. Fails open, not closed.
        TargetFormat::Aiff => vec![
            s("-write_id3v2"),
            s("1"),
            s("-id3v2_version"),
            s("3"),
            s("-f"),
            s("aiff"),
        ],
        TargetFormat::Wav => vec![s("-f"), s("wav")],
        TargetFormat::Flac => vec![s("-f"), s("flac")],
    }
}

/// Runs one ffmpeg invocation, streaming both pipes.
///
/// Both pipes must be drained concurrently. With `-progress pipe:1` ffmpeg
/// writes a status block roughly twice a second, so reading only stderr blocks
/// the child the moment stdout's 64 KiB buffer fills — that is a certainty on
/// any file longer than a few minutes, not a rare race.
/// Lines ffmpeg emits that say nothing about the job, and that this app causes
/// itself.
///
/// The only one so far: the mov muxer sniffs the output filename and warns when
/// `-f ipod` is writing to something that is not `.m4a`/`.m4v`. Every ALAC and
/// AAC file here trips it, because the encode goes to `Track.m4a.part` and is
/// renamed only once it is complete — the extension it objects to belongs to
/// the half-written marker, and the finished file always carries the right one.
/// The muxer is chosen by `-f`, not by the name, so the container is correct
/// either way.
///
/// One meaningless line per file, in a pane that exists to be read, trains the
/// user to ignore the pane. Dropped here rather than at `-v error`, which would
/// also silence the warnings that do mean something.
fn is_self_inflicted_noise(line: &str) -> bool {
    line.contains("extension is not .m4a nor .m4v")
}

fn run_ffmpeg(
    mut cmd: Command,
    control: &ConvertControl,
    obs: &dyn ConvertObserver,
    index: usize,
    name: &str,
    duration_s: f64,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let id = control.register(child);

    // Kept so a failure message stays as informative as the old
    // `.output()`-based one, which had the whole of stderr to hand.
    let tail: Mutex<Vec<String>> = Mutex::new(Vec::new());

    std::thread::scope(|s| {
        if let Some(err) = stderr {
            s.spawn(|| {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    let line = line.trim().to_string();
                    if line.is_empty() || is_self_inflicted_noise(&line) {
                        continue;
                    }
                    let level = if line.contains("Error")
                        || line.contains("error")
                        || line.contains("Invalid")
                    {
                        "error"
                    } else {
                        "warn"
                    };
                    obs.log(level, Some(name), &line);
                    let mut t = tail.lock().unwrap();
                    if t.len() == 20 {
                        t.remove(0);
                    }
                    t.push(line);
                }
            });
        }
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                // -progress emits `key=value` blocks; out_time_us is decode
                // position, which is the only progress signal ffmpeg offers.
                // It is NOT output bytes — a fact worth remembering when the
                // bar moves unevenly across stream-copy and encode items.
                if duration_s > 0.0 {
                    if let Some(us) = line.strip_prefix("out_time_us=") {
                        if let Ok(us) = us.trim().parse::<f64>() {
                            let f = (us / 1_000_000.0 / duration_s).clamp(0.0, 1.0);
                            obs.file_progress(index, f);
                        }
                    }
                }
            }
        }
    });

    // A cancel may have taken and killed the child already.
    let status = match control.take(id) {
        Some(mut child) => child.wait().map_err(|e| e.to_string())?,
        None => return Err("cancelled".into()),
    };
    if status.success() {
        Ok(())
    } else {
        let msg = tail.lock().unwrap().join(" | ");
        Err(if msg.is_empty() {
            format!("ffmpeg exited with {status}")
        } else {
            msg
        })
    }
}

/// Convert one file (or one cue slice) to `target` at `dst`.
#[allow(clippy::too_many_arguments)]
fn convert_one(
    tools: &Tools,
    probe: &MediaProbe,
    src: &Path,
    dst: &Path,
    cue: Option<&CueMeta>,
    art_cache: &ArtCache,
    target: &TargetSpec,
    control: &ConvertControl,
    obs: &dyn ConvertObserver,
    index: usize,
) -> Result<(), String> {
    let trimming = cue.is_some();
    let out_rate = target_rate(probe.sample_rate);
    let float_target = target.format.wants_float(encoders().aac_at);

    // Whether the audio needs touching at all depends on the target. A lossy
    // encoder does not care about source bit depth — only the rate ceiling
    // and the channel count reach it.
    let needs_work = if float_target {
        target_rate(probe.sample_rate) != probe.sample_rate || probe.channels > 2 || probe.is_dsd()
    } else {
        probe.needs_work()
    };

    let mut filters: Vec<String> = Vec::new();
    if needs_work {
        // DSD carries a mountain of ultrasonic shaping noise; kill it before
        // decimating.
        if probe.is_dsd() {
            filters.push(format!("lowpass=f={}", out_rate * 45 / 100));
        }
        let mut ares = format!("aresample={}:osr={}", resampler_args(), out_rate);
        if !float_target {
            ares.push_str(":osf=s16");
            // Dither only when losing resolution. Upconverting 8-bit needs
            // none, and a float encoder needs none at all.
            if probe.bits > 16 {
                ares.push_str(":dither_method=triangular_hp");
            }
        }
        filters.push(ares);
    }

    // Already in spec and already ALAC — nothing to gain from re-encoding
    // (cue slices still re-encode: stream copy can't cut mid-frame cleanly).
    let copy_codec =
        target.format == TargetFormat::Alac && probe.codec == "alac" && !needs_work && !trimming;

    // Artwork: prefer what's embedded in the source; otherwise adopt the
    // folder cover. Oversized or non-JPEG art is re-encoded to a small JPEG
    // the iPod renders reliably; in-spec JPEG art is stream-copied untouched.
    let art = if !target.format.can_embed_art() {
        ArtPlan::None
    } else if let Some(codec) = &probe.art_codec {
        ArtPlan::Embedded {
            norm: codec != "mjpeg" || probe.art_w > ART_MAX_EDGE || probe.art_h > ART_MAX_EDGE,
        }
    } else if let Some(pick) = src
        .parent()
        .and_then(|dir| art_cache.cover_in(&tools.ffprobe, dir))
    {
        if pick.norm {
            // Normalize once per album through the cache; on failure fall
            // back to letting ffmpeg re-encode it inline for every track.
            match art_cache.normalized(&tools.ffmpeg, &pick.path) {
                Some(cached) => ArtPlan::File {
                    path: cached,
                    norm: false,
                },
                None => ArtPlan::File {
                    path: pick.path,
                    norm: true,
                },
            }
        } else {
            ArtPlan::File {
                path: pick.path,
                norm: false,
            }
        }
    } else {
        ArtPlan::None
    };

    let tmp = dst.with_extension(format!("{}.part", target.format.ext()));
    let display = dst
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // A cue slice's span, not the whole album image — otherwise the per-file
    // bar for track 1 of 12 would creep to 8% and stop.
    let effective_duration = match cue {
        Some(meta) => meta
            .end
            .map(|e| (e - meta.start).max(0.0))
            .unwrap_or_else(|| (probe.duration_s - meta.start).max(0.0)),
        None => probe.duration_s,
    };

    let attempt = |art: &ArtPlan, force_norm: bool, trim_db: Option<f64>| -> Result<(), String> {
        let mut cmd = Command::new(&tools.ffmpeg);
        // -v warning rather than -v error: at error level there is essentially
        // nothing to show, and the log pane exists to be read.
        cmd.args([
            "-hide_banner",
            "-nostdin",
            "-v",
            "warning",
            "-y",
            "-progress",
            "pipe:1",
            "-nostats",
        ]);
        if let Some(meta) = cue {
            // Input-side seek: the FLAC seektable lands at the track start
            // instantly where an output filter had to decode everything
            // before it — quadratic over the album. Still sample-accurate.
            cmd.args(["-ss", &format!("{:.6}", meta.start)]);
            if let Some(end) = meta.end {
                let dur = end - meta.start;
                if dur > 0.0 {
                    cmd.args(["-t", &format!("{dur:.6}")]);
                }
            }
        }
        cmd.arg("-i").arg(src);

        // An attached picture is a single frame at t=0, so the input seek
        // would drop it; trimmed tracks read their embedded art through a
        // second, un-seeked copy of the source instead.
        let art_input: Option<i32> = match art {
            ArtPlan::None => None,
            ArtPlan::Embedded { .. } => {
                if trimming {
                    cmd.arg("-i").arg(src);
                    Some(1)
                } else {
                    Some(0)
                }
            }
            ArtPlan::File { path, .. } => {
                cmd.arg("-i").arg(path);
                Some(1)
            }
        };

        cmd.args(["-map", "0:a:0"]);
        match art_input {
            None => {
                cmd.arg("-vn");
            }
            Some(idx) => {
                cmd.args(["-map", &format!("{idx}:v:0")]);
                let norm = force_norm
                    || match art {
                        ArtPlan::Embedded { norm } | ArtPlan::File { norm, .. } => *norm,
                        ArtPlan::None => false,
                    };
                if norm {
                    cmd.args(ART_NORM_OPTS);
                } else {
                    cmd.args(["-c:v", "copy"]);
                }
                cmd.args(["-disposition:v", "attached_pic"]);
            }
        }

        // Attenuation goes in front of the resampler so any dither the chain
        // adds is still the last thing to touch the samples.
        let chain: Vec<String> = trim_db
            .map(|db| format!("volume={db:.2}dB"))
            .into_iter()
            .chain(filters.iter().cloned())
            .collect();
        if !chain.is_empty() {
            cmd.args(["-af", &chain.join(",")]);
        }
        if copy_codec {
            cmd.args(["-c:a", "copy"]);
        } else {
            for arg in encoder_args(target) {
                cmd.arg(arg);
            }
            if probe.channels > 2 {
                cmd.args(["-ac", "2"]);
            }
        }
        cmd.args(["-map_metadata", "0"]);
        if let Some(meta) = cue {
            cmd.args(["-metadata", &format!("title={}", meta.title)]);
            cmd.args(["-metadata", &format!("artist={}", meta.artist)]);
            cmd.args(["-metadata", &format!("album={}", meta.album)]);
            cmd.args([
                "-metadata",
                &format!("track={}/{}", meta.track_num, meta.track_total),
            ]);
            if !meta.date.is_empty() {
                cmd.args(["-metadata", &format!("date={}", meta.date)]);
            }
            if !meta.genre.is_empty() {
                cmd.args(["-metadata", &format!("genre={}", meta.genre)]);
            }
            if !meta.album_artist.is_empty() {
                cmd.args(["-metadata", &format!("album_artist={}", meta.album_artist)]);
            }
        }
        for arg in muxer_args(target.format) {
            cmd.arg(arg);
        }
        cmd.arg(&tmp);

        // Stream-copy finishes effectively instantly and has no useful
        // intra-file progress; passing 0 suppresses the per-file bar rather
        // than parking it at zero.
        let progress_span = if copy_codec { 0.0 } else { effective_duration };
        run_ffmpeg(cmd, control, obs, index, &display, progress_span)
    };

    // Some sources hold artwork ffmpeg can decode but not stream-copy into
    // MP4. Retry re-encoding the picture, then as a last resort drop it.
    //
    // Every rung checks the cancel flag first: a SIGKILLed attempt looks
    // exactly like a genuine failure from here, and without the check a
    // cancelled file would fire two more ffmpeg runs on its way out.
    let dropped_art = ArtPlan::None;
    let mut used_art = &art;
    let mut used_norm = false;
    let mut result = attempt(&art, false, None);
    if result.is_err() && !control.cancelled() && !matches!(art, ArtPlan::None) {
        let _ = std::fs::remove_file(&tmp);
        used_norm = true;
        result = attempt(&art, true, None);
        if result.is_err() && !control.cancelled() {
            let _ = std::fs::remove_file(&tmp);
            used_art = &dropped_art;
            used_norm = false;
            result = attempt(&dropped_art, false, None);
        }
    }

    // A lossy encoder hands back a waveform that overshoots the one it was
    // given, and the device clips what it cannot represent. Nothing predicts
    // the overshoot from the source — this master's true peak is −0.05 dBTP
    // and it still decodes to +1.45 dBFS — so the encoded file is measured and
    // re-encoded attenuated when it would clip. Lossless targets are exact and
    // are left alone.
    if result.is_ok() && !target.format.is_lossless() {
        let mut trim = 0.0;
        for _ in 0..MAX_HEADROOM_PASSES {
            if control.cancelled() {
                break;
            }
            let Some(peak) = decoded_peak_db(&tools.ffmpeg, &tmp) else {
                break;
            };
            let Some(step) = headroom_gain_db(peak) else {
                break;
            };
            trim += step;
            obs.log(
                "warn",
                Some(&display),
                &format!("decodes back to {peak:+.2} dBFS — re-encoding {trim:.2} dB down"),
            );
            let _ = std::fs::remove_file(&tmp);
            result = attempt(used_art, used_norm, Some(trim));
            if result.is_err() {
                break;
            }
        }
    }

    match result {
        Ok(()) => {
            std::fs::rename(&tmp, dst).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Classify one work item and convert it if needed. `out_dir` must exist.
///
/// The passthrough shortcuts below exist because the import path's target is
/// ALAC and a file already in that shape is best left untouched. They are all
/// gated on the target actually being ALAC — a user who asked for MP3 must get
/// MP3, not a silently forwarded original.
#[allow(clippy::too_many_arguments)]
fn prepare_one(
    item: &WorkItem,
    out_dir: &Path,
    layout: OutLayout,
    names: &NameReserver,
    art_cache: &ArtCache,
    target: &TargetSpec,
    control: &ConvertControl,
    obs: &dyn ConvertObserver,
    index: usize,
) -> Prepared {
    let to_alac = target.format == TargetFormat::Alac;

    if to_alac && item.cue.is_none() && is_direct_ext(&item.src) {
        return Prepared::Ready(item.src.clone());
    }

    let Some(tools) = tools() else {
        // Without ffprobe an .m4a can't be classified — import it directly,
        // exactly as the app behaved before conversion existed.
        if to_alac && item.cue.is_none() && lower_ext(&item.src) == "m4a" {
            return Prepared::Ready(item.src.clone());
        }
        return Prepared::Rejected(FFMPEG_MISSING.into());
    };

    let probe = match item.probe.clone() {
        // convert_add already probed this item; re-probing a several-thousand
        // file queue costs a second full ffprobe pass for nothing.
        Some(p) if !p.codec.is_empty() => p,
        _ => match probe_media(&tools.ffprobe, &item.src) {
            Some(p) if !p.codec.is_empty() => p,
            _ => return Prepared::Rejected("unreadable audio file".into()),
        },
    };

    if let Some(reason) = reject_pairing(&probe, target) {
        return Prepared::Rejected(reason);
    }

    if to_alac && item.cue.is_none() && lower_ext(&item.src) == "m4a" && !probe.needs_work() {
        return Prepared::Ready(item.src.clone()); // already iPod-spec ALAC
    }

    let ext = target.format.ext();
    let dst = match layout {
        OutLayout::Scratch => out_dir.join(format!("{}.{}", item.dst_stem, ext)),
        // Drop the "12/" the scratch layout prefixes, and take a unique name in
        // its place. A folder the user picked gets files, not a numbered
        // directory per track.
        OutLayout::UserFolder => {
            let stem = Path::new(&item.dst_stem)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| item.dst_stem.clone());
            out_dir.join(names.reserve(&stem, ext))
        }
    };
    if let Some(parent) = dst.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return Prepared::Rejected("couldn't create output directory".into());
        }
    }
    match convert_one(
        tools,
        &probe,
        &item.src,
        &dst,
        item.cue.as_ref(),
        art_cache,
        target,
        control,
        obs,
        index,
    ) {
        Ok(()) => Prepared::Ready(dst),
        Err(_) if control.cancelled() => Prepared::Cancelled,
        Err(e) => Prepared::Rejected(format!("conversion failed: {e}")),
    }
}

/// Whether this source/target pair is worth doing at all. Refusal is a
/// property of both, not of the source alone: transcoding a 320 kbps MP3 down
/// to 128 kbps AAC to fit a full iPod is the single most legitimate reason
/// anyone wants a converter, while the same MP3 to Apple Lossless only wastes
/// space.
pub fn reject_pairing(probe: &MediaProbe, target: &TargetSpec) -> Option<String> {
    if probe.is_lossless() {
        return None;
    }
    if target.format.is_lossless() {
        return Some(format!(
            "{} is already lossy — converting it to {} would only make it larger",
            probe.codec.to_uppercase(),
            target.format.label()
        ));
    }
    // Lossy to lossy: only downward. Re-encoding at the same or a higher
    // bitrate spends generation loss and gains nothing.
    let target_bps = match target.rate {
        Rate::Cbr(kbps) => kbps as u64 * 1000,
        // A VBR index has no bitrate until it encodes; allow it and let the
        // result speak. Index 0 is roughly 195-245 kbps depending on encoder.
        Rate::Vbr(_) => 0,
        Rate::Lossless => 0,
    };
    if target_bps > 0 && probe.bit_rate > 0 && target_bps >= probe.bit_rate {
        return Some(format!(
            "source is already {} kbps — re-encoding at {} kbps would lose quality for no saving",
            probe.bit_rate / 1000,
            target_bps / 1000
        ));
    }
    None
}

/// Above this, in dBFS, a decode is asking for sample values the device has no
/// room to represent.
///
/// A lossy encoder is not required to keep its reconstruction inside full
/// scale and none of them do: this album's master peaks at −0.18 dBFS and
/// comes back out of AAC at +1.45. The iPod's output stage is fixed point, so
/// every one of those samples saturates — a handful at a time, heard as a
/// short bright click on loud passages. A master sitting exactly on full scale
/// is not a problem and is deliberately left alone; only the overshoot is.
const LOSSY_CLIP_CEILING_DB: f64 = 0.0;

/// What a corrective re-encode aims for. Deliberately below the ceiling:
/// attenuating the input by N dB does not move the decoded peak by exactly N,
/// so aiming at the ceiling itself lands half the files a hair over it and
/// buys a second re-encode for nothing. A dB of headroom is inaudible as a
/// level change.
const LOSSY_PEAK_TARGET_DB: f64 = -1.0;

/// How many corrective re-encodes one file may spend. Attenuating the input by
/// N dB moves the decoded peak by very nearly N, so the first correction lands
/// almost exactly on the ceiling; the second is there for the encoder that
/// does something less linear, and beyond that the file is left as it is
/// rather than transcoded a fourth time.
const MAX_HEADROOM_PASSES: usize = 2;

/// Attenuation to re-encode with, given what the last encode decoded back to.
/// None when it already clears the ceiling — including the silent file, whose
/// peak parses as `-inf`.
fn headroom_gain_db(peak_db: f64) -> Option<f64> {
    (peak_db > LOSSY_CLIP_CEILING_DB).then_some(LOSSY_PEAK_TARGET_DB - peak_db)
}

/// The overall `Peak level dB:` out of an astats summary. Per-channel blocks
/// carry the same key, so the first hit wins — with `measure_perchannel=none`
/// asked for below, the only one printed is the overall figure.
fn parse_peak_level_db(log: &str) -> Option<f64> {
    log.lines()
        .find_map(|line| line.split("Peak level dB:").nth(1))
        .and_then(|value| value.trim().parse::<f64>().ok())
}

/// What `path` decodes back to, as a sample peak in dBFS. Decoding is forced
/// to float: the integer pipeline saturates at 0 dB and would report every
/// overshooting file as sitting exactly on full scale.
fn decoded_peak_db(ffmpeg: &Path, path: &Path) -> Option<f64> {
    let out = output_with_timeout(
        Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-v", "info", "-nostats", "-i"])
            .arg(path)
            .args([
                "-map",
                "0:a:0",
                "-af",
                "aformat=fltp,astats=measure_perchannel=none",
                "-f",
                "null",
                "-",
            ]),
        MEASURE_TIMEOUT,
    )
    .ok()?;
    parse_peak_level_db(&String::from_utf8_lossy(&out.stderr))
}

/// Everything a caller can learn while a batch runs. The old callback fired
/// only when an item finished, which left the bar frozen for the length of one
/// ten-minute DSD file.
pub trait ConvertObserver: Sync {
    fn started(&self, _index: usize, _name: &str) {}
    /// 0..1 within the current file. Never called for stream-copy items or
    /// sources whose duration is unknown — there is no denominator.
    fn file_progress(&self, _index: usize, _fraction: f64) {}
    fn log(&self, _level: &'static str, _file: Option<&str>, _line: &str) {}
    /// Outcome of one item, by its index in the batch. Separate from
    /// `finished`, which carries a running count and cannot identify the row
    /// it belongs to.
    fn item_done(&self, _index: usize, _outcome: &Prepared) {}
    fn finished(&self, _done: usize, _name: &str) {}
}

/// Preserves the pre-converter behaviour: forward finish counts, drop the rest.
pub struct ProgressOnly<'a>(pub &'a (dyn Fn(usize, &str) + Sync));

impl ConvertObserver for ProgressOnly<'_> {
    fn finished(&self, done: usize, name: &str) {
        (self.0)(done, name);
    }
}

/// Cancellation state shared with the running batch. Children are registered
/// on spawn so a cancel can kill work already in flight rather than waiting
/// for a ten-minute encode to finish on its own.
#[derive(Default)]
pub struct ConvertControl {
    flag: std::sync::atomic::AtomicBool,
    children: Mutex<Vec<(u32, std::process::Child)>>,
}

impl ConvertControl {
    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// Reset at the START of a run, never at the end: a cancel arriving in the
    /// gap between two runs would otherwise leak forward and kill the next one.
    pub fn arm(&self) {
        self.flag.store(false, Ordering::Relaxed);
        self.children.lock().unwrap().clear();
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
        for (_, child) in self.children.lock().unwrap().iter_mut() {
            let _ = child.kill();
        }
    }

    fn register(&self, child: std::process::Child) -> u32 {
        let id = child.id();
        self.children.lock().unwrap().push((id, child));
        id
    }

    /// Hands the child back so the caller can wait on it. None when a cancel
    /// already took it and killed it.
    fn take(&self, id: u32) -> Option<std::process::Child> {
        let mut guard = self.children.lock().unwrap();
        let pos = guard.iter().position(|(cid, _)| *cid == id)?;
        Some(guard.remove(pos).1)
    }
}

/// Convert a batch on a worker pool. Results come back in input order.
/// Where the batch is writing, which decides what the output directory is
/// allowed to look like.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OutLayout {
    /// A scratch directory this app made and will delete. `dst_stem`'s
    /// per-item subdirectory is free collision avoidance and nobody sees it.
    Scratch,
    /// A directory the user chose and keeps. The numbered subdirectories are an
    /// implementation detail of the scratch layout and have no business being
    /// there, so names are flattened and made unique instead.
    UserFolder,
}

/// Reserves output filenames for `OutLayout::UserFolder`.
///
/// Flattening `12/Song` to `Song` is what re-introduces the collision the
/// subdirectory existed to prevent — two albums both holding `01 Intro` now
/// want one name. Workers race for it, so the check and the claim have to be
/// one locked step; `exists` is consulted under the same lock because the
/// user's folder may already hold a `Song.m4a` from an earlier run, and ffmpeg
/// runs with `-y` and would overwrite it without a word.
struct NameReserver {
    dir: PathBuf,
    taken: Mutex<HashSet<String>>,
}

impl NameReserver {
    fn new(dir: &Path) -> Self {
        NameReserver {
            dir: dir.to_path_buf(),
            taken: Mutex::new(HashSet::new()),
        }
    }

    fn reserve(&self, stem: &str, ext: &str) -> String {
        let mut taken = self.taken.lock().unwrap();
        // Case-insensitively, because APFS is by default: "Song.m4a" and
        // "song.m4a" are one file, and handing both out loses one of them.
        let mut name = format!("{stem}.{ext}");
        let mut n = 2;
        while !taken.insert(name.to_lowercase()) || self.dir.join(&name).exists() {
            name = format!("{stem} ({n}).{ext}");
            n += 1;
        }
        name
    }
}

pub fn prepare_batch(
    items: &[WorkItem],
    out_dir: &Path,
    target: &TargetSpec,
    control: &ConvertControl,
    obs: &dyn ConvertObserver,
) -> Vec<Prepared> {
    prepare_batch_into(items, out_dir, OutLayout::Scratch, target, control, obs)
}

pub fn prepare_batch_into(
    items: &[WorkItem],
    out_dir: &Path,
    layout: OutLayout,
    target: &TargetSpec,
    control: &ConvertControl,
    obs: &dyn ConvertObserver,
) -> Vec<Prepared> {
    if items.is_empty() {
        return Vec::new();
    }
    let _ = std::fs::create_dir_all(out_dir);
    // The art cache is scratch either way. Inside a scratch out_dir it is
    // deleted with everything else; inside the user's folder it was simply left
    // behind, which is how an `artcache` directory ended up sitting next to
    // their music.
    let art_dir = match layout {
        OutLayout::Scratch => out_dir.to_path_buf(),
        OutLayout::UserFolder => fresh_out_dir(),
    };
    let art_cache = ArtCache::new(&art_dir);
    let names = NameReserver::new(out_dir);

    // Half the cores: ffmpeg's ALAC path is single-threaded but the decode +
    // resample chain still saturates a core; leave headroom for the UI.
    let workers = std::thread::available_parallelism()
        .map(|n| n.get() / 2)
        .unwrap_or(4)
        .clamp(2, 8)
        .min(items.len());

    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<Prepared>>> =
        (0..items.len()).map(|_| Mutex::new(None)).collect();

    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                // Checked before claiming an index, so a cancel stops the
                // queue advancing rather than merely killing what is running.
                if control.cancelled() {
                    break;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(i) else { break };
                let name = item.display();
                obs.started(i, &name);
                let prepared = prepare_one(
                    item, out_dir, layout, &names, &art_cache, target, control, obs, i,
                );
                obs.item_done(i, &prepared);
                *results[i].lock().unwrap() = Some(prepared);
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                obs.finished(n, &name);
            });
        }
    });

    // Only ever a scratch directory of our own making — the `UserFolder` branch
    // above put it under the temp dir precisely so this line can be
    // unconditional without ever reaching into the user's folder.
    if layout == OutLayout::UserFolder {
        let _ = std::fs::remove_dir_all(&art_dir);
    }

    // Workers that broke out on the cancel flag never wrote a slot; those
    // items were never attempted and must not be reported as failures.
    results
        .into_iter()
        .map(|m| m.into_inner().unwrap().unwrap_or(Prepared::Cancelled))
        .collect()
}

/// Scratch directory for one conversion run, unique per call.
pub fn fresh_out_dir() -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "PlatterConvert-{stamp}-{}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

// ---------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_rate_stays_in_clock_family() {
        assert_eq!(target_rate(44100), 44100);
        assert_eq!(target_rate(88200), 44100);
        assert_eq!(target_rate(176400), 44100);
        assert_eq!(target_rate(352800), 44100);
        assert_eq!(target_rate(48000), 48000);
        assert_eq!(target_rate(96000), 48000);
        assert_eq!(target_rate(192000), 48000);
        assert_eq!(target_rate(32000), 44100);
        assert_eq!(target_rate(64000), 48000);
        assert_eq!(target_rate(0), 44100);
    }

    #[test]
    fn headroom_gain_only_answers_for_an_overshoot() {
        assert_eq!(headroom_gain_db(-3.0), None);
        // A master that touches full scale exactly is representable and must
        // not be turned down.
        assert_eq!(headroom_gain_db(LOSSY_CLIP_CEILING_DB), None);
        assert_eq!(headroom_gain_db(f64::NEG_INFINITY), None); // silence
        // Peak measured off a real AAC encode of this album's master.
        let gain = headroom_gain_db(1.45).expect("overshoot needs a trim");
        assert!((gain - -2.45).abs() < 1e-9, "got {gain}");
        // The trim aims below the ceiling, so a re-encode that tracked it
        // exactly would not trigger a second pass.
        assert_eq!(headroom_gain_db(1.45 + gain), None);
    }

    #[test]
    fn peak_level_comes_out_of_an_astats_summary() {
        let log = "[Parsed_astats_1 @ 0x14] Overall\n\
                   [Parsed_astats_1 @ 0x14] DC offset: 0.000031\n\
                   [Parsed_astats_1 @ 0x14] Peak level dB: 1.451928\n\
                   [Parsed_astats_1 @ 0x14] RMS level dB: -9.8\n";
        assert_eq!(parse_peak_level_db(log), Some(1.451928));
        assert_eq!(
            parse_peak_level_db("[x] Peak level dB: -inf\n"),
            Some(f64::NEG_INFINITY)
        );
        assert_eq!(parse_peak_level_db("no summary here"), None);
    }

    #[test]
    fn bits_fall_back_to_sample_fmt() {
        assert_eq!(bits_from_sample_fmt("s16"), 16);
        assert_eq!(bits_from_sample_fmt("s16p"), 16);
        assert_eq!(bits_from_sample_fmt("s32"), 32);
        assert_eq!(bits_from_sample_fmt("flt"), 32);
        assert_eq!(bits_from_sample_fmt("fltp"), 32);
        assert_eq!(bits_from_sample_fmt("dsd_lsbf"), 1);
        assert_eq!(bits_from_sample_fmt(""), 0);
    }

    #[test]
    fn needs_work_matrix() {
        let base = MediaProbe {
            codec: "alac".into(),
            sample_rate: 44100,
            channels: 2,
            bits: 16,
            sample_fmt: "s16p".into(),
            ..Default::default()
        };
        assert!(!base.needs_work());
        assert!(MediaProbe {
            sample_rate: 96000,
            ..base.clone()
        }
        .needs_work());
        assert!(MediaProbe {
            bits: 24,
            ..base.clone()
        }
        .needs_work());
        assert!(MediaProbe {
            channels: 6,
            ..base.clone()
        }
        .needs_work());
        assert!(MediaProbe {
            codec: "dsd_lsbf".into(),
            ..base.clone()
        }
        .needs_work());
        assert!(MediaProbe {
            sample_fmt: "s32p".into(),
            ..base
        }
        .needs_work());
    }

    #[test]
    fn cue_parses_tracks_and_encodings() {
        let dir = std::env::temp_dir().join(format!("platter-cue-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("album.flac"), b"x").unwrap();
        let cue = "REM GENRE \"Jazz\"\nREM DATE 1959\nPERFORMER \"Miles Davis\"\nTITLE \"Kind of Blue\"\nFILE \"album.flac\" WAVE\n  TRACK 01 AUDIO\n    TITLE \"So What\"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE \"Freddie Freeloader\"\n    PERFORMER \"M. Davis\"\n    INDEX 01 09:22:15\n";
        let cue_path = dir.join("album.cue");
        std::fs::write(&cue_path, cue).unwrap();

        let sheet = parse_cue(&cue_path).expect("cue should parse");
        assert_eq!(sheet.audio_file, dir.join("album.flac"));
        assert_eq!(sheet.tracks.len(), 2);
        let t1 = &sheet.tracks[0];
        assert_eq!(t1.title, "So What");
        assert_eq!(t1.artist, "Miles Davis");
        assert_eq!(t1.album, "Kind of Blue");
        assert_eq!(t1.genre, "Jazz");
        assert_eq!(t1.date, "1959");
        assert_eq!(t1.start, 0.0);
        assert_eq!(t1.end, Some(9.0 * 60.0 + 22.0 + 15.0 / 75.0));
        let t2 = &sheet.tracks[1];
        assert_eq!(t2.artist, "M. Davis");
        assert_eq!(t2.end, None);
        assert_eq!(t2.track_num, 2);
        assert_eq!(t2.track_total, 2);

        // single-track cue is not an album image — rejected
        let single = "FILE \"album.flac\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n";
        std::fs::write(dir.join("single.cue"), single).unwrap();
        assert!(parse_cue(&dir.join("single.cue")).is_none());

        // cp1251 title decodes (Кровь = 0xCA 0xF0 0xEE 0xE2 0xFC)
        let mut cp1251 = Vec::new();
        cp1251.extend_from_slice(b"TITLE \"");
        cp1251.extend_from_slice(&[0xCA, 0xF0, 0xEE, 0xE2, 0xFC]);
        cp1251.extend_from_slice(b"\"\nFILE \"album.flac\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 01:00:00\n");
        std::fs::write(dir.join("ru.cue"), &cp1251).unwrap();
        let sheet = parse_cue(&dir.join("ru.cue")).expect("cp1251 cue should parse");
        assert_eq!(sheet.tracks[0].album, "Кровь");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The failure this guards against is silent and severe: a partially
    /// parameterised path writes MP3 or PCM bytes into a file still named
    /// `.m4a`, libgpod copies it to the device with an `M4A ` marker, and the
    /// track is unplayable with no error anywhere in the chain. Asserting the
    /// command merely exited 0 would not catch it — the codec and the
    /// extension both have to be checked.
    #[test]
    fn a_user_folder_gets_files_not_a_directory_per_track() {
        let Some(tools) = tools() else {
            eprintln!("skipping: ffmpeg not installed");
            return;
        };
        let dir = std::env::temp_dir().join(format!("platter-flat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Two sources with the same stem from different album folders — the
        // exact collision the "12/" prefix existed to prevent. FLAC in, so the
        // ALAC target has real work to do and cannot pass the source through.
        let mut items = Vec::new();
        for album in ["A", "B"] {
            let src_dir = dir.join(format!("src-{album}"));
            std::fs::create_dir_all(&src_dir).unwrap();
            let src = src_dir.join("01 Intro.flac");
            assert!(Command::new(&tools.ffmpeg)
                .args([
                    "-hide_banner",
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-c:a",
                    "flac",
                ])
                .arg(&src)
                .status()
                .unwrap()
                .success());
            items.push(WorkItem {
                src,
                // What the queue builds: a per-item subdirectory.
                dst_stem: format!("{}/01 Intro", items.len()),
                cue: None,
                probe: None,
            });
        }

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let results = prepare_batch_into(
            &items,
            &out,
            OutLayout::UserFolder,
            &TargetSpec::alac(),
            &ConvertControl::default(),
            &ProgressOnly(&|_, _| {}),
        );
        for r in &results {
            if let Prepared::Rejected(why) = r {
                panic!("rejected: {why}");
            }
            assert!(matches!(r, Prepared::Ready(_)), "cancelled");
        }

        let mut entries: Vec<String> = std::fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();

        // Files, not directories, and no `artcache` left sitting in there.
        for name in &entries {
            assert!(out.join(name).is_file(), "{name} should be a file");
        }
        assert_eq!(
            entries,
            vec!["01 Intro (2).m4a", "01 Intro.m4a"],
            "{entries:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ipod_muxers_extension_warning_is_dropped() {
        // The literal ffmpeg emits, with the muxer tag it carries.
        assert!(is_self_inflicted_noise(
            "[ipod @ 0xb42c28280] Warning, extension is not .m4a nor .m4v Quicktime/Ipod might not play the file"
        ));
    }

    #[test]
    fn real_warnings_survive_the_filter() {
        // Nothing here is caused by the .part name, so all of it has to reach
        // the log — the filter exists to remove one false positive, not to make
        // the pane quiet.
        for line in [
            "[flac @ 0x7f8] Could not find codec parameters",
            "Error while decoding stream #0:0: Invalid data found when processing input",
            "[ipod @ 0x600] Encoder did not produce proper pts, making some up.",
            "Past duration 0.999992 too large",
        ] {
            assert!(!is_self_inflicted_noise(line), "{line}");
        }
    }

    #[test]
    fn every_target_writes_its_own_codec_and_extension() {
        let Some(tools) = tools() else {
            eprintln!("skipping: ffmpeg not installed");
            return;
        };
        let dir = std::env::temp_dir().join(format!("platter-fmt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.flac");
        assert!(Command::new(&tools.ffmpeg)
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-c:a",
                "flac",
            ])
            .arg(&src)
            .status()
            .unwrap()
            .success());

        let enc = encoders();
        let cases: Vec<(TargetSpec, &str)> = vec![
            (TargetSpec::alac(), "alac"),
            (
                TargetSpec {
                    format: TargetFormat::Aac,
                    rate: Rate::Cbr(256),
                    ipod_safe: true,
                },
                "aac",
            ),
            (
                TargetSpec {
                    format: TargetFormat::Aiff,
                    rate: Rate::Lossless,
                    ipod_safe: true,
                },
                "pcm_s16be",
            ),
            (
                TargetSpec {
                    format: TargetFormat::Wav,
                    rate: Rate::Lossless,
                    ipod_safe: true,
                },
                "pcm_s16le",
            ),
            (
                TargetSpec {
                    format: TargetFormat::Flac,
                    rate: Rate::Lossless,
                    ipod_safe: true,
                },
                "flac",
            ),
        ];

        for (target, want_codec) in cases {
            let items = vec![WorkItem {
                src: src.clone(),
                dst_stem: format!("out-{}", target.format.ext()),
                cue: None,
                probe: None,
            }];
            let out = dir.join(format!("o-{:?}", target.format));
            let results = prepare_batch(
                &items,
                &out,
                &target,
                &ConvertControl::default(),
                &ProgressOnly(&|_, _| {}),
            );
            let path = match &results[0] {
                Prepared::Ready(p) => p.clone(),
                other => panic!(
                    "{:?} did not convert: {}",
                    target.format,
                    match other {
                        Prepared::Rejected(r) => r.clone(),
                        _ => "cancelled".into(),
                    }
                ),
            };
            assert_eq!(
                lower_ext(&path),
                target.format.ext(),
                "{:?} wrote the wrong extension",
                target.format
            );
            let probe = probe_media(&tools.ffprobe, &path)
                .unwrap_or_else(|| panic!("{:?} output does not probe", target.format));
            assert_eq!(
                probe.codec,
                want_codec,
                "{:?} wrote {} inside a .{} — a mislabelled file",
                target.format,
                probe.codec,
                target.format.ext()
            );
            assert!(probe.duration_s > 1.0, "{:?} lost the audio", target.format);
        }

        // MP3 needs lame, which a trimmed ffmpeg may lack; skip rather than
        // fail a build that legitimately can't encode it.
        if enc.lame {
            let target = TargetSpec {
                format: TargetFormat::Mp3,
                rate: Rate::Cbr(192),
                ipod_safe: true,
            };
            let items = vec![WorkItem {
                src: src.clone(),
                dst_stem: "out-mp3".into(),
                cue: None,
                probe: None,
            }];
            let out = dir.join("o-mp3");
            let results = prepare_batch(
                &items,
                &out,
                &target,
                &ConvertControl::default(),
                &ProgressOnly(&|_, _| {}),
            );
            let path = match &results[0] {
                Prepared::Ready(p) => p.clone(),
                _ => panic!("mp3 did not convert"),
            };
            assert_eq!(lower_ext(&path), "mp3");
            assert_eq!(probe_media(&tools.ffprobe, &path).unwrap().codec, "mp3");
        }

        // -write_id3v2 fails OPEN: without it the aiff muxer still exits 0,
        // having dropped every tag. Only the chunk itself proves it worked.
        let aiff = dir.join("o-Aiff").join("out-aiff.aiff");
        let bytes = std::fs::read(&aiff).expect("aiff output");
        assert!(
            bytes.windows(4).any(|w| w == b"ID3 "),
            "AIFF carries no ID3 chunk — tags and cover art were silently dropped"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Full pipeline against a real ffmpeg: hi-res FLAC + folder cover +
    /// cue-split album image all come out as iPod-spec ALAC. Skips silently
    /// when ffmpeg isn't installed (CI without Homebrew).
    #[test]
    fn e2e_converts_hires_and_cue_split() {
        let Some(tools) = tools() else {
            eprintln!("skipping: ffmpeg not installed");
            return;
        };
        let dir = std::env::temp_dir().join(format!("platter-e2e-test-{}", std::process::id()));
        let album = dir.join("Album");
        std::fs::create_dir_all(&album).unwrap();

        let gen = |args: &[&str], out: &Path| {
            let ok = Command::new(&tools.ffmpeg)
                .args(["-hide_banner", "-v", "error", "-y"])
                .args(args)
                .arg(out)
                .status()
                .unwrap()
                .success();
            assert!(ok, "fixture generation failed for {}", out.display());
        };

        // 24-bit / 96 kHz stereo FLAC — must downconvert to 16/48.
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-af",
                "aformat=sample_fmts=s32:channel_layouts=stereo",
                "-ar",
                "96000",
                "-sample_fmt",
                "s32",
                "-c:a",
                "flac",
                "-bits_per_raw_sample",
                "24",
            ],
            &album.join("hires.flac"),
        );
        // Oversized PNG folder cover — must be normalized and embedded.
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=red:size=1200x1200",
                "-frames:v",
                "1",
            ],
            &album.join("cover.png"),
        );
        // 4-second 44.1/16 album image with a 2-track cue.
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=330:duration=4",
                "-af",
                "aformat=sample_fmts=s16:channel_layouts=stereo",
                "-ar",
                "44100",
                "-c:a",
                "flac",
            ],
            &album.join("image.flac"),
        );
        std::fs::write(
            album.join("image.cue"),
            "PERFORMER \"Tester\"\nTITLE \"Cue Album\"\nFILE \"image.flac\" WAVE\nTRACK 01 AUDIO\nTITLE \"One\"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE \"Two\"\nINDEX 01 00:02:00\n",
        )
        .unwrap();

        let items = scan(&[dir.display().to_string()]);
        assert_eq!(items.len(), 3, "hires + 2 cue tracks");

        let out_dir = dir.join("out");
        let results = prepare_batch(
            &items,
            &out_dir,
            &TargetSpec::alac(),
            &ConvertControl::default(),
            &ProgressOnly(&|_, _| {}),
        );

        let mut checked_hires = false;
        let mut cue_outputs = 0;
        for (item, prepared) in items.iter().zip(&results) {
            let Prepared::Ready(path) = prepared else {
                panic!("{} was rejected", item.display());
            };
            let probe = probe_media(&tools.ffprobe, path).expect("output must probe");
            assert_eq!(probe.codec, "alac", "{}", item.display());
            assert!(probe.sample_rate <= 48000);
            assert!(probe.sample_fmt.starts_with("s16"));
            assert!(probe.channels <= 2);
            if item.cue.is_none() {
                checked_hires = true;
                assert_eq!(probe.sample_rate, 48000, "96k stays in 48k family");
                assert!(probe.art_codec.is_some(), "folder cover embedded");
                assert!(
                    probe.art_w <= 600 && probe.art_h <= 600,
                    "cover normalized to <=600px"
                );
            } else {
                cue_outputs += 1;
                // Split tracks carry the cue tags.
                let tagged = lofty::probe::Probe::open(path).unwrap().read().unwrap();
                use lofty::file::TaggedFileExt;
                use lofty::prelude::*;
                let tag = tagged.primary_tag().expect("cue tags embedded");
                assert_eq!(tag.artist().as_deref(), Some("Tester"));
                assert_eq!(tag.album().as_deref(), Some("Cue Album"));
                let secs = tagged.properties().duration().as_secs_f64();
                assert!(
                    (secs - 2.0).abs() < 0.15,
                    "each cue slice is ~2s, got {secs}"
                );
            }
        }
        assert!(checked_hires);
        assert_eq!(cue_outputs, 2);

        // Oversized JPEG folder cover (right extension, wrong size) must
        // still be rescaled — its size only shows via an ffprobe of the
        // image itself.
        let album2 = dir.join("Album2");
        std::fs::create_dir_all(&album2).unwrap();
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:size=1400x1400",
                "-frames:v",
                "1",
                "-q:v",
                "3",
            ],
            &album2.join("cover.jpg"),
        );
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=220:duration=1",
                "-af",
                "aformat=sample_fmts=s16:channel_layouts=stereo",
                "-ar",
                "44100",
                "-c:a",
                "flac",
            ],
            &album2.join("song.flac"),
        );
        let items = scan(&[album2.display().to_string()]);
        let results = prepare_batch(
            &items,
            &out_dir,
            &TargetSpec::alac(),
            &ConvertControl::default(),
            &ProgressOnly(&|_, _| {}),
        );
        let Prepared::Ready(path) = &results[0] else {
            panic!("in-spec flac with big jpeg cover was rejected");
        };
        let probe = probe_media(&tools.ffprobe, path).unwrap();
        assert!(probe.art_codec.is_some(), "big jpeg cover embedded");
        assert!(
            probe.art_w <= 600 && probe.art_h <= 600,
            "oversized jpeg cover rescaled, got {}x{}",
            probe.art_w,
            probe.art_h
        );

        // In-spec ALAC m4a passes through untouched (same path back).
        let inspec = album.join("already.m4a");
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=550:duration=1",
                "-af",
                "aformat=sample_fmts=s16:channel_layouts=stereo",
                "-ar",
                "44100",
                "-c:a",
                "alac",
                "-sample_fmt",
                "s16p",
            ],
            &inspec,
        );
        let items = scan(&[inspec.display().to_string()]);
        let results = prepare_batch(
            &items,
            &out_dir,
            &TargetSpec::alac(),
            &ConvertControl::default(),
            &ProgressOnly(&|_, _| {}),
        );
        match &results[0] {
            Prepared::Ready(p) => assert_eq!(p, &inspec, "no pointless re-encode"),
            Prepared::Rejected(r) => panic!("in-spec alac rejected: {r}"),
            Prepared::Cancelled => panic!("nothing cancelled this batch"),
        }

        // Lossy-in-lossless-container is rejected, not converted.
        let lossy = album.join("lossy.wv.wav");
        gen(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=550:duration=1",
                "-c:a",
                "adpcm_ima_wav",
            ],
            &lossy,
        );
        let items = scan(&[lossy.display().to_string()]);
        let results = prepare_batch(
            &items,
            &out_dir,
            &TargetSpec::alac(),
            &ConvertControl::default(),
            &ProgressOnly(&|_, _| {}),
        );
        assert!(
            matches!(&results[0], Prepared::Rejected(r) if r.contains("lossy")),
            "adpcm wav must be rejected as lossy"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_recurses_dedupes_and_splits() {
        let dir = std::env::temp_dir().join(format!("platter-scan-test-{}", std::process::id()));
        let sub = dir.join("Album");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("loose.mp3"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(sub.join("image.flac"), b"x").unwrap();
        std::fs::write(sub.join("cover.jpg"), b"x").unwrap();
        std::fs::write(
            sub.join("image.cue"),
            "FILE \"image.flac\" WAVE\nTRACK 01 AUDIO\nTITLE \"A\"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE \"B\"\nINDEX 01 01:00:00\n",
        )
        .unwrap();

        // dropping the folder AND the cue AND the image must not duplicate
        let items = scan(&[
            dir.display().to_string(),
            sub.join("image.cue").display().to_string(),
            sub.join("image.flac").display().to_string(),
        ]);
        let cue_items: Vec<_> = items.iter().filter(|i| i.cue.is_some()).collect();
        let direct: Vec<_> = items.iter().filter(|i| i.cue.is_none()).collect();
        assert_eq!(cue_items.len(), 2, "two cue tracks");
        assert_eq!(direct.len(), 1, "one loose mp3");
        assert!(direct[0].src.ends_with("loose.mp3"));
        assert!(cue_items[0].dst_stem.ends_with("/01 A"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
