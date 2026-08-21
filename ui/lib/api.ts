import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { describeError, log, summarizeArgs } from "./log";
import type {
  AccessRequest,
  AppIconInfo,
  ConvertEstimateResult,
  Destination,
  FormatOption,
  ImportResult,
  JobSummary,
  LibraryPatch,
  LibrarySnapshot,
  PendingImport,
  SourceRow,
  TargetSpec,
  TrackFields,
  VolumeInfo,
  VolumeScan,
} from "./types";

/** Fields set_field can stamp across a selection — string-valued ones only;
 * the numeric fields are per-track by nature. */
export type BulkField = "artist" | "albumArtist" | "album" | "composer" | "genre";

/** Commands too frequent to narrate. `get_artwork` runs once per visible
 * thumbnail — a scroll through a large library is thousands of calls.
 * `list_volumes` is polled every 2.5s for as long as no iPod is connected, so
 * a log that traced it would be nothing but volume scans by the time anyone
 * read it; `DisconnectedView` logs the scans that actually changed something
 * instead. Failures still get a line either way: a cover that won't load, or a
 * scan that can't run, is a real report. */
const QUIET = new Set(["get_artwork", "list_volumes"]);

/** The single IPC choke point, and so the natural place to trace it. Every
 * call is logged with its shape, its duration and its outcome, which means the
 * 24 command signatures on the Rust side need no instrumentation of their own.
 *
 * The pre-flush is what keeps the file readable: whatever the user did to
 * cause this call is still sitting in the batch buffer, and this puts it above
 * the call rather than up to 250ms below it. */
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const quiet = QUIET.has(command);
  if (!quiet) {
    log.info(`cmd.${command}`, summarizeArgs(args));
    log.flush();
  }
  const started = performance.now();
  try {
    const result = await tauriInvoke<T>(command, args);
    if (!quiet) log.info(`cmd.${command} ok`, `${Math.round(performance.now() - started)}ms`);
    return result;
  } catch (e) {
    log.error(`cmd.${command} failed`, describeError(e));
    throw e;
  }
}

export const api = {
  listVolumes: () => invoke<VolumeInfo[]>("list_volumes"),
  openLibrary: (mountPoint: string) =>
    invoke<LibrarySnapshot>("open_library", { mountPoint }),
  closeLibrary: () => invoke<LibrarySnapshot>("close_library"),
  ejectIpod: () => invoke<LibrarySnapshot>("eject_ipod"),
  /** Counts importable audio on a volume without importing anything. */
  scanVolume: (path: string) => invoke<VolumeScan>("scan_volume", { path }),
  openPrivacySettings: () => invoke<void>("open_privacy_settings"),
  /** Clears the recorded TCC answer and touches a volume so macOS raises its
   * own consent modal. Resolves only once the user has answered that modal. */
  requestVolumeAccess: () => invoke<AccessRequest>("request_volume_access"),

  listAppIcons: () => invoke<AppIconInfo[]>("list_app_icons"),
  getAppIcon: () => invoke<string | null>("get_app_icon"),
  /** null restores the bundle icon. Applies and persists in one call. */
  setAppIcon: (id: string | null) => invoke<void>("set_app_icon", { id }),
  readTags: (paths: string[]) => invoke<PendingImport[]>("read_tags", { paths }),
  importTracks: (items: PendingImport[]) =>
    // The preview data URL is dead weight on the way back in — the backend
    // only reads artworkPath, and full-size covers over JSON IPC add up fast.
    invoke<ImportResult>("import_tracks", {
      items: items.map((i) => ({ ...i, artworkDataUrl: null })),
    }),
  importFiles: (paths: string[]) =>
    invoke<ImportResult>("import_files", { paths }),
  /* Mutations answer with a LibraryPatch — just the touched tracks — rather
   * than a full snapshot. At tens of thousands of tracks, re-shipping the
   * whole library over JSON IPC per edit froze the UI for its serialization,
   * transfer and parse, and replacing every Track object also invalidated
   * every identity-keyed cache (search haystacks, memo'd rows) at once. */
  updateTrack: (id: string, fields: TrackFields) =>
    invoke<LibraryPatch>("update_track", { id, fields }),
  setField: (ids: string[], field: BulkField, value: string) =>
    invoke<LibraryPatch>("set_field", { ids, field, value }),
  /** All named fields stamped in one lock take and one round-trip — the bulk
   * panel used to loop set_field per changed field. */
  setFields: (ids: string[], fields: [BulkField, string][]) =>
    invoke<LibraryPatch>("set_fields", { ids, fields }),
  setArtwork: (ids: string[], imagePath: string) =>
    invoke<LibraryPatch>("set_artwork", { ids, imagePath }),
  removeTracks: (ids: string[]) =>
    invoke<LibraryPatch>("remove_tracks", { ids }),
  getArtwork: (id: string, size: number) =>
    invoke<string | null>("get_artwork", { id, size }),

  convertFormats: () => invoke<FormatOption[]>("convert_formats"),
  /** One open panel taking audio files *and* folders — the plugin's dialog
   * splits those into two calls, so this goes through NSOpenPanel instead.
   * Empty when the user cancels. */
  pickMusic: () => invoke<string[]>("pick_music"),
  convertAdd: (paths: string[]) => invoke<SourceRow[]>("convert_add", { paths }),
  convertRemove: (ids: number[]) => invoke<SourceRow[]>("convert_remove", { ids }),
  convertClear: () => invoke<SourceRow[]>("convert_clear"),
  convertEstimate: (target: TargetSpec, destination: Destination) =>
    invoke<ConvertEstimateResult>("convert_estimate", { target, destination }),
  convertStart: (target: TargetSpec, destination: Destination) =>
    invoke<JobSummary>("convert_start", { target, destination }),
  cancelConvert: () => invoke<void>("cancel_convert"),

  /** Shown in Settings so the file is findable when export is what's broken. */
  logPath: () => invoke<string>("log_path"),
  /** Writes this session and the one before it to `dest`. */
  exportLogs: (dest: string) => invoke<void>("export_logs", { dest }),
};

/** Artwork thumbnails keyed by track id + size. Two layers: a Promise map so
 * concurrent mounts share one fetch, and a resolved map so remounts can paint
 * synchronously with no placeholder flash. Entries survive metadata edits —
 * art only changes through set_artwork / remove / open, which invalidate
 * explicitly. Both maps are FIFO-capped: scrolling a several-thousand-album
 * library must not grow them (and the base64 strings they hold) without
 * bound. Maps iterate in insertion order, so eviction just deletes the
 * oldest keys seen first.
 *
 * Fetches run through a small scheduler rather than firing invoke() on mount:
 * every get_artwork serializes on the backend's single library mutex, so a
 * fling-scroll through thousands of album headers used to enqueue an
 * unbounded FIFO of extractions — the rows on screen were served LAST, after
 * every row scrolled past. Now at most ART_CONCURRENCY are in flight, pending
 * work dispatches newest-first (what's on screen went in last), and a request
 * whose every thumb unmounted before dispatch is dropped without the IPC
 * round-trip. */
const ART_CACHE_LIMIT = 1500;
const ART_CONCURRENCY = 5;

/** The only thumbnail sizes the backend is ever asked for.
 *
 * Every distinct size is a separate cache key on both sides and a separate
 * pixbuf decode plus encode in the C bridge, so a caller passing its own pixel
 * size — the treemap sizes tiles from the viewport — could ask for a hundred
 * near-identical variants of one cover. Two rungs cover every use: 80 for the
 * list, headers and wall tiles, 320 for the inspector and the share card,
 * which is also retina-sharp at the 160 the mosaic displays. Anything larger
 * than the top rung is served at the top rung and scaled down by CSS. */
const ART_SIZES = [80, 320] as const;

export function artworkFetchSize(displaySize: number): number {
  return ART_SIZES.find((s) => s >= displaySize) ?? ART_SIZES[ART_SIZES.length - 1];
}
const artworkPromises = new Map<string, Promise<string | null>>();
const artworkResolved = new Map<string, string | null>();
/** Live subscriber count per key — retained by mounted thumbs. */
const artInterest = new Map<string, number>();

interface PendingArt {
  key: string;
  id: string;
  size: number;
  promise: Promise<string | null>;
  resolve: (url: string | null) => void;
}
const artQueue: PendingArt[] = [];
let artInFlight = 0;

function trimArtworkCaches() {
  if (artworkPromises.size <= ART_CACHE_LIMIT) return;
  let toDrop = artworkPromises.size - ART_CACHE_LIMIT;
  for (const key of artworkPromises.keys()) {
    artworkPromises.delete(key);
    artworkResolved.delete(key);
    if (--toDrop <= 0) break;
  }
}

function pumpArtQueue() {
  while (artInFlight < ART_CONCURRENCY && artQueue.length > 0) {
    const next = artQueue.pop()!; // LIFO: most recently requested first
    // Invalidated while queued — resolve without publishing; the artVersion
    // bump already told mounted thumbs to re-request.
    if (artworkPromises.get(next.key) !== next.promise) {
      next.resolve(null);
      continue;
    }
    // Nobody is looking any more (scrolled past before dispatch): skip the
    // backend call entirely, and forget the promise so a future mount
    // fetches fresh.
    if (!(artInterest.get(next.key) ?? 0)) {
      artworkPromises.delete(next.key);
      next.resolve(null);
      continue;
    }
    artInFlight++;
    api
      .getArtwork(next.id, next.size)
      .then(
        (url) => {
          // Only publish if this fetch is still the current one — an
          // invalidation while it was in flight means the result is stale.
          if (artworkPromises.get(next.key) === next.promise) {
            artworkResolved.set(next.key, url);
          }
          next.resolve(url);
        },
        () => {
          // A rejection is transient (IPC hiccup, contention), not "no art".
          // Dropping the promise lets the next request retry; publishing null
          // would make the cover missing for the whole session.
          if (artworkPromises.get(next.key) === next.promise) {
            artworkPromises.delete(next.key);
          }
          next.resolve(null);
        },
      )
      .finally(() => {
        artInFlight--;
        pumpArtQueue();
      });
  }
}

/** A mounted thumb's declaration of interest — pair every retain with a
 * release in the effect cleanup, or queued fetches stop being droppable. */
export function retainArtwork(id: string, size: number) {
  const key = `${id}@${size}`;
  artInterest.set(key, (artInterest.get(key) ?? 0) + 1);
}

export function releaseArtwork(id: string, size: number) {
  const key = `${id}@${size}`;
  const n = (artInterest.get(key) ?? 0) - 1;
  if (n <= 0) artInterest.delete(key);
  else artInterest.set(key, n);
}

export function cachedArtwork(id: string, size: number): Promise<string | null> {
  const key = `${id}@${size}`;
  let hit = artworkPromises.get(key);
  if (!hit) {
    let resolve!: (url: string | null) => void;
    hit = new Promise<string | null>((r) => {
      resolve = r;
    });
    artworkPromises.set(key, hit);
    trimArtworkCaches();
    artQueue.push({ key, id, size, promise: hit, resolve });
    pumpArtQueue();
  }
  return hit;
}

/** Synchronous cache read — undefined means "not fetched yet". */
export function resolvedArtwork(id: string, size: number): string | null | undefined {
  return artworkResolved.get(`${id}@${size}`);
}

/** Republishes a cover the webview refused to decode as "no art".
 *
 * A data URL that fails to paint is not a missing cover as far as the <img>
 * is concerned — WebKit swaps in its own broken-image icon, which on macOS is
 * the system question-mark tile: foreign to this UI and unreadable as either
 * "no cover" or "bug". The thumb reports the failure here instead, so this
 * key falls back to the music-note placeholder for every mount, not just the
 * one that happened to paint it. The mark is an ordinary cache entry, so
 * invalidateArtwork drops it and a replaced cover is fetched again. */
export function markArtworkUndecodable(id: string, size: number) {
  const key = `${id}@${size}`;
  const url = artworkResolved.get(key);
  log.warn("artwork undecodable", {
    id,
    size,
    // The whole data URL is megabytes of base64; its head is the part that
    // says which encoder produced it, which is what a mime/bytes mismatch
    // shows up in.
    head: typeof url === "string" ? url.slice(0, 32) : String(url),
  });
  artworkResolved.set(key, null);
  artworkPromises.set(key, Promise.resolve(null));
  trimArtworkCaches();
}

/** Bumped on every invalidation; ArtworkThumb subscribes so already-mounted
 * thumbs refetch when their track's cover was replaced (their trackId prop
 * doesn't change in that case, so nothing else would re-run the effect). */
let artVersion = 0;
const artListeners = new Set<() => void>();

export function subscribeArt(listener: () => void): () => void {
  artListeners.add(listener);
  return () => artListeners.delete(listener);
}

export function getArtVersion(): number {
  return artVersion;
}

/** Drop cached art for specific tracks, or everything when ids is omitted
 * (library reopened — pointers are meaningless across opens). */
export function invalidateArtwork(ids?: string[]) {
  if (!ids) {
    artworkPromises.clear();
    artworkResolved.clear();
  } else {
    for (const id of ids) {
      for (const map of [artworkPromises, artworkResolved] as const) {
        for (const key of map.keys()) {
          if (key.startsWith(`${id}@`)) map.delete(key);
        }
      }
    }
  }
  artVersion++;
  for (const listener of artListeners) listener();
}
