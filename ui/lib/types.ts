export interface Track {
  id: string;
  title: string;
  artist: string;
  /** Blank when unset — the iPod then groups the album under `artist`. */
  albumArtist: string;
  album: string;
  composer: string;
  genre: string;
  fileType: string;
  trackNumber: number;
  /** Tracks on this disc; 0 when unset. */
  trackCount: number;
  discNumber: number;
  discCount: number;
  year: number;
  bitrate: number;
  /** Hz; 0 when the database never recorded one. */
  sampleRate: number;
  durationMs: number;
  sizeBytes: number;
  /** Unix epoch seconds; null when the device never recorded one. */
  dateAdded: number | null;
  hasArtwork: boolean;
  /** Lifetime plays recorded by the device. */
  playCount: number;
  /** 0–100, 20 per star. 0 = unrated. */
  rating: number;
  /** Unix epoch seconds of the last play; null when never played. */
  lastPlayed: number | null;
  /** Device path in the database's colon form, e.g. ":iPod_Control:Music:F04:X.mp3". */
  ipodPath: string;
  /** False means a database record with no audio file behind it. */
  transferred: boolean;
  hasDrm: boolean;
}

/** Fields the inspector writes back. Sent whole, so blanks clear. */
export interface TrackFields {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  composer: string;
  genre: string;
  trackNumber: number;
  trackCount: number;
  discNumber: number;
  discCount: number;
  year: number;
}

export interface Capacity {
  freeBytes: number;
  totalBytes: number;
}

export interface LibrarySnapshot {
  mountPoint: string | null;
  tracks: Track[];
  capacity: Capacity | null;
}

/** What a mutation actually changed — folded into the frontend's track array
 * in place of the full snapshot mutations used to return, so an edit's cost
 * scales with what it touched instead of with the library. */
export interface LibraryPatch {
  /** Post-edit state of every surviving track the operation touched. */
  updated: Track[];
  /** Ids that no longer resolve — removed, or gone under us. */
  removedIds: string[];
  capacity: Capacity | null;
}

export interface VolumeInfo {
  path: string;
  isIpod: boolean;
  /** Live statvfs capacity; null when the lookup fails. */
  freeBytes: number | null;
  totalBytes: number | null;
  /** Read from iPod_Control/Device/SysInfo. All null for a non-iPod volume,
   * and for an iPod whose SysInfo is missing or names a model libgpod's table
   * doesn't carry — restored and hand-built devices hit that. */
  family: string | null;
  /** libgpod's own name, which omits the "iPod" prefix: "Classic (Black)". */
  model: string | null;
  generation: string | null;
  /** True only for a device positively identified as one this app can't
   * manage — a Shuffle keeps its library in iTunesSD, a Touch in neither.
   * Never true for an unidentified device. */
  unsupported: boolean;
}

/** What importing a whole volume would bring in. Produced by the same scan
 * the import itself runs, so the count is what actually lands. */
export interface VolumeScan {
  tracks: number;
  /** Subset of `tracks` coming from cue sheets — those need an ffmpeg render
   * before they can be imported, so they cost far more than plain files. */
  cueTracks: number;
}

/** Outcome of asking macOS for removable-volume access through its own
 * consent modal. */
export interface AccessRequest {
  /** True when a removable volume reads back after the user answered. */
  granted: boolean;
  /** False for a dev build launched from a terminal: the TCC decision belongs
   * to that terminal, so no modal for Platter can appear at all. */
  bundled: boolean;
  /** The volume that was probed; null when none was mounted. */
  volume: string | null;
}

export interface PendingImport {
  filePath: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  composer: string;
  genre: string;
  trackNumber: number;
  trackCount: number;
  discNumber: number;
  discCount: number;
  year: number;
  durationMs: number;
  /** Read off the stream, not the tags; 0 when unknown. */
  bitrate: number;
  sampleRate: number;
  artworkPath: string | null;
  artworkDataUrl: string | null;
}

export interface ImportResult {
  snapshot: LibrarySnapshot;
  imported: number;
  failures: string[];
  /** Indices into the submitted items for entries that failed to import. */
  failedIndices: number[];
}

/** What the import dialog needs to decide whether to close: full success, or
 * which staged rows to keep for retry. */
export interface ImportOutcome {
  ok: boolean;
  failedIndices: number[];
}

export interface Progress {
  text: string;
  /** 0…1 for countable work, null when the UI should show a spinner. */
  fraction: number | null;
}

/* ------------------------------------------------------------- converter */

export type TargetFormat = "alac" | "aac" | "mp3" | "aiff" | "wav" | "flac";

/** Mirrors the Rust `Rate` enum's serde shape: unit variant or single-field
 * struct variant. */
export type Rate = "lossless" | { cbr: number } | { vbr: number };

export interface TargetSpec {
  format: TargetFormat;
  rate: Rate;
  /** Clamp to 16-bit / ≤48 kHz / stereo. Forced on for an iPod destination. */
  ipodSafe: boolean;
}

export interface FormatOption {
  format: TargetFormat;
  label: string;
  ext: string;
  ipodPlayable: boolean;
  lossless: boolean;
  /** Non-null means the option is greyed out, with this as the reason. */
  unavailable: string | null;
  encoder: string;
}

export interface SourceRow {
  id: number;
  srcPath: string;
  display: string;
  cueTrack: number | null;
  codec: string;
  sampleRate: number;
  channels: number;
  bits: number;
  /** 0 = unknown, never "empty". */
  durationS: number;
  sourceBytes: number;
  /** Why this row can't go to the chosen format, if it can't. */
  blocked: string | null;
}

export type Destination = { kind: "folder"; path: string } | { kind: "ipod" };

export type FitVerdict = "fits" | "tight" | "doesNotFit" | "unknown";

export interface Estimate {
  fileCount: number;
  blockedCount: number;
  totalDurationS: number;
  sourceBytes: number;
  /** Headline number. */
  likelyBytes: number;
  /** Pessimistic bound — what the verdict is computed against. */
  highBytes: number;
  /** True when the arithmetic really is exact, so the UI can drop "about". */
  exact: boolean;
  unknownDurationCount: number;
  destPath: string;
  destFreeBytes: number;
  destTotalBytes: number;
  destFsType: string;
  /** Boot-volume free space; present only for an iPod destination. */
  scratchFreeBytes: number | null;
  headroomBytes: number;
  verdict: FitVerdict;
  oversizeFiles: string[];
  notes: string[];
}

export interface ConvertEstimateResult {
  estimate: Estimate;
  rows: SourceRow[];
}

export interface JobSummary {
  jobId: number;
  converted: number;
  failed: number;
  cancelled: boolean;
  /** What was actually written — the honest check on the estimate. */
  outputBytes: number;
  outputDir: string | null;
  failures: string[];
}

export interface ConvertProgress {
  jobId: number;
  phase: "scanning" | "converting" | "importing" | "cleanup";
  done: number;
  total: number;
  fraction: number | null;
  current: string;
  /** 0…1 inside the current file; null for stream copies and unknown lengths. */
  fileFraction: number | null;
}

export interface ConvertLogLine {
  seq: number;
  /** Who is speaking, not how loud. `cmd` is this app narrating what it is
   * about to do, `ok` is a track that landed, `info` is the job talking about
   * itself, and `warn`/`error` are ffmpeg's own words. */
  level: "info" | "ok" | "warn" | "error" | "cmd";
  file: string | null;
  line: string;
}

export interface ConvertLogBatch {
  jobId: number;
  lines: ConvertLogLine[];
}

/** Where one queued row is in the run. "queued" is never sent — it is what a
 * row with no update yet means while a job is running. */
export type ConvertItemStatus =
  | "queued"
  | "converting"
  | "converted"
  | "importing"
  | "imported"
  | "failed"
  | "cancelled";

export interface ConvertItemUpdate {
  /** SourceRow.id this update is about. */
  id: number;
  status: ConvertItemStatus;
  /** Failure reason, or null. */
  detail: string | null;
}

export interface ConvertItemBatch {
  jobId: number;
  updates: ConvertItemUpdate[];
}

export type AppView = "library" | "convert" | "stats";

export type TrackGrouping = "none" | "artist" | "album" | "genre";

/** What the list is ordered by.
 *
 * The four the View menu has always offered are joined here by one key per
 * remaining column heading, because every heading is clickable and a heading
 * that sorts by nothing looks broken. Album has no key of its own: sorting by
 * album and not by track number within it would scatter each album's tracks,
 * so the Album heading asks for `albumOrder`. */
export type TrackSortKey =
  | "title"
  | "artist"
  | "albumOrder"
  | "genre"
  | "trackNumber"
  | "year"
  | "time"
  | "bitrate"
  | "plays"
  | "recentlyAdded";

/** `asc` is the order the key is defined in, `desc` that order reversed — so
 * "Recently Added, ascending" is newest first, the direction the name of the
 * sort implies, and descending is oldest first. */
export type SortDirection = "asc" | "desc";

export interface TrackSortState {
  key: TrackSortKey;
  dir: SortDirection;
}

export const GROUPING_LABELS: Record<TrackGrouping, string> = {
  none: "No Grouping",
  artist: "Artist",
  album: "Album",
  genre: "Genre",
};


/** Genres the Classic's Genres menu commonly shows — free text still works. */
export const COMMON_GENRES = [
  "Rock",
  "Pop",
  "Hip-Hop/Rap",
  "Electronic",
  "Jazz",
  "Classical",
  "Country",
  "R&B/Soul",
  "Metal",
  "Folk",
  "Podcast",
  "Other",
];

export const IMPORTABLE_EXTENSIONS = ["mp3", "m4a", "aac"];

/** One selectable app icon. `id` is null for the bundle's own icon, and
 * `preview` is a data: URL the backend renders from the same bytes it applies,
 * so the tile always shows what you'll actually get. */
export interface AppIconInfo {
  id: string | null;
  label: string;
  preview: string;
}
