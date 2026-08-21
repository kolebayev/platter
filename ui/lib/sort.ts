/** What each view is sorted by, and how a click on a column heading changes it.
 *
 * The sort is stored per grouping rather than once for the whole list. The two
 * are not independent settings that happen to sit next to each other in the
 * View menu: album order is the only order that makes sense under an album
 * header, and it is a poor one for a flat list, where the album a track came
 * from is a column like any other. Sharing one value would mean every switch
 * between grouped and flat silently re-sorted the view you were leaving.
 *
 * The DOM-free half is what `sort.test.ts` covers; vitest runs without a
 * browser. */

import type { ColumnKey } from "./columns";
import type { SortDirection, TrackGrouping, TrackSortKey, TrackSortState } from "./types";

/** The order a column heading asks for.
 *
 * Album maps to `albumOrder`, not to a bare album comparison: sorting by album
 * title alone would leave each album's own tracks in whatever order they were
 * already in, which is the one thing nobody clicking "Album" wants. */
export const COLUMN_SORTS: Record<ColumnKey, TrackSortKey> = {
  title: "title",
  artist: "artist",
  album: "albumOrder",
  genre: "genre",
  trackNumber: "trackNumber",
  year: "year",
  time: "time",
  bitrate: "bitrate",
  plays: "plays",
  dateAdded: "recentlyAdded",
};

/** Whether a heading is the one currently sorted by, which is what decides if
 * it draws an arrow. */
export function isSortedBy(column: ColumnKey, sort: TrackSortState): boolean {
  return COLUMN_SORTS[column] === sort.key;
}

/** Clicking the column already sorted by reverses it; clicking any other
 * starts that column ascending. Ascending first for every column, including
 * the numeric ones: "highest play count first" is a reasonable guess at intent
 * and a terrible one to be wrong about, and the second click is free. */
export function nextSortFor(column: ColumnKey, current: TrackSortState): TrackSortState {
  const key = COLUMN_SORTS[column];
  if (key !== current.key) return { key, dir: "asc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** Which way the heading's arrow points.
 *
 * Not simply the direction: `recentlyAdded` ascends into the past — its
 * ascending order is newest first, because that is what the name of the sort
 * promises. An up arrow over a column of dates counting downwards would be
 * describing the key, not the column, so the arrow follows the dates. */
export function sortsDescending(sort: TrackSortState): boolean {
  const reversed = sort.dir === "desc";
  return sort.key === "recentlyAdded" ? !reversed : reversed;
}

/** Flat view opens on artist A–Z: with no headers to say whose track this is,
 * the artist column is what turns the list into something readable, and a
 * library-wide album order would interleave artists at random. The grouped
 * views open in album order, which is how the tracks sit under their headers
 * on the iPod itself. */
export const DEFAULT_SORTS: Record<TrackGrouping, TrackSortState> = {
  none: { key: "artist", dir: "asc" },
  artist: { key: "albumOrder", dir: "asc" },
  album: { key: "albumOrder", dir: "asc" },
  genre: { key: "albumOrder", dir: "asc" },
};

export type SortPrefs = Record<TrackGrouping, TrackSortState>;

const GROUPINGS: readonly TrackGrouping[] = ["none", "artist", "album", "genre"];
const SORT_KEYS: readonly TrackSortKey[] = [
  "title",
  "artist",
  "albumOrder",
  "genre",
  "trackNumber",
  "year",
  "time",
  "bitrate",
  "plays",
  "recentlyAdded",
];

function isSortKey(value: unknown): value is TrackSortKey {
  return typeof value === "string" && SORT_KEYS.includes(value as TrackSortKey);
}

function isDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

/** Tolerant by design — this parses whatever was in localStorage, which may
 * predate a sort key existing, or have been hand-edited. Anything it cannot
 * recognize falls back to that view's default rather than to `undefined`,
 * which would reach the comparator table as a missing function.
 *
 * `legacy` is the single value written by builds before the sort was stored
 * per view. It seeds the grouped views only: flat view had no sort of its own
 * to inherit, and its default is the point of having one. */
export function normalizeSortPrefs(raw: unknown, legacy?: unknown): SortPrefs {
  const stored = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = {} as SortPrefs;
  for (const grouping of GROUPINGS) {
    const fallback =
      grouping !== "none" && isSortKey(legacy)
        ? { key: legacy, dir: "asc" as SortDirection }
        : DEFAULT_SORTS[grouping];
    const entry = stored[grouping];
    if (typeof entry !== "object" || entry === null) {
      out[grouping] = fallback;
      continue;
    }
    const { key, dir } = entry as { key?: unknown; dir?: unknown };
    out[grouping] = {
      key: isSortKey(key) ? key : fallback.key,
      dir: isDirection(dir) ? dir : fallback.dir,
    };
  }
  return out;
}

// ---------------------------------------------------------------- DOM side

const STORAGE_KEY = "trackSortByGrouping";
/** Written by builds that stored one sort for every view. */
const LEGACY_KEY = "trackSort";

export function readSortPrefs(): SortPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeSortPrefs(
      raw === null ? null : JSON.parse(raw),
      localStorage.getItem(LEGACY_KEY),
    );
  } catch {
    return normalizeSortPrefs(null);
  }
}

export function writeSortPrefs(prefs: SortPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
