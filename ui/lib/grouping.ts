// Port of ContentView.swift's grouping/sorting/search logic. Pure functions
// over Track arrays — the Swift originals were too, which is why this file is
// nearly a transcription.

import type { SortDirection, Track, TrackGrouping, TrackSortState } from "./types";

export interface AlbumSubgroup {
  id: string;
  title: string;
  tracks: Track[];
  /** First track with artwork — the thumbnail asks the backend for its art. */
  artTrackId: string | null;
  missingArtCount: number;
}

export interface TrackGroup {
  id: string;
  title: string;
  tracks: Track[];
  /** Non-null only when grouping by artist. */
  albums: AlbumSubgroup[] | null;
  artTrackId: string | null;
}

/** localizedStandardCompare's closest web equivalent: numeric, case/diacritic
 * insensitive ("Track 2" < "Track 10"). */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Lowercased search haystack per track, computed once per Track object —
 * they're immutable snapshots, so a WeakMap survives exactly as long as the
 * snapshot does. Saves 4 toLowerCase calls per track per keystroke. */
const haystacks = new WeakMap<Track, string>();

function haystack(track: Track): string {
  let h = haystacks.get(track);
  if (h === undefined) {
    h = `${track.title}\u0000${track.artist}\u0000${track.album}\u0000${track.genre}`.toLowerCase();
    haystacks.set(track, h);
  }
  return h;
}

export function matches(track: Track, query: string): boolean {
  return haystack(track).includes(query.toLowerCase());
}

/** Variant for callers filtering a whole list: the query is lowercased once
 * up front rather than once per track. */
function matchesLower(track: Track, loweredQuery: string): boolean {
  return haystack(track).includes(loweredQuery);
}

function newestDate(tracks: Track[]): number | null {
  let newest: number | null = null;
  for (const t of tracks) {
    if (t.dateAdded !== null && (newest === null || t.dateAdded > newest)) {
      newest = t.dateAdded;
    }
  }
  return newest;
}

type Comparator = (a: Track, b: Track) => number;

/** Every sort settles ties on title, so an order is total and a re-sort of the
 * same tracks can't shuffle rows that compare equal. */
const byTitle: Comparator = (a, b) => collator.compare(a.title, b.title);

/** A number the database may never have recorded, where 0 means "unknown" —
 * year, bitrate, play count. Unknown sorts first ascending, which keeps the
 * blanks together at one end rather than scattered through the list. */
function numerically(of: (track: Track) => number): Comparator {
  return (a, b) => {
    const x = of(a);
    const y = of(b);
    return x === y ? byTitle(a, b) : x - y;
  };
}

/** One per TrackSortKey. Each is the ASCENDING order; descending is this
 * negated, tie-breaks included — reversing the whole comparator is what makes
 * a descending list the exact mirror of the ascending one. */
const COMPARATORS: Record<TrackSortState["key"], Comparator> = {
  title: byTitle,
  artist: (a, b) =>
    a.artist === b.artist ? byTitle(a, b) : collator.compare(a.artist, b.artist),
  albumOrder: (a, b) => {
    if (a.album !== b.album) return collator.compare(a.album, b.album);
    // Disc before track: without it a two-disc set interleaves, because
    // both discs restart their numbering at 1. Unset (0) sorts first,
    // which keeps single-disc albums exactly where they were.
    if (a.discNumber !== b.discNumber) return a.discNumber - b.discNumber;
    if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
    return byTitle(a, b);
  },
  genre: (a, b) => (a.genre === b.genre ? byTitle(a, b) : collator.compare(a.genre, b.genre)),
  // The heading reads "#", and a disc number is part of what that number
  // means: track 1 of disc 2 is not track 1.
  trackNumber: (a, b) => {
    if (a.discNumber !== b.discNumber) return a.discNumber - b.discNumber;
    if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
    return byTitle(a, b);
  },
  year: numerically((t) => t.year),
  time: numerically((t) => t.durationMs),
  bitrate: numerically((t) => t.bitrate),
  plays: numerically((t) => t.playCount),
  // Newest first is this sort's ascending order: "Recently Added" names the
  // top of the list, so reversing it has to mean oldest first. Undated tracks
  // trail the dated ones and so lead under a reversal.
  recentlyAdded: (a, b) => {
    if (a.dateAdded !== null && b.dateAdded !== null && a.dateAdded !== b.dateAdded) {
      return b.dateAdded - a.dateAdded;
    }
    if (a.dateAdded === null && b.dateAdded !== null) return 1;
    if (a.dateAdded !== null && b.dateAdded === null) return -1;
    return byTitle(a, b);
  },
};

function directed(comparator: Comparator, dir: SortDirection): Comparator {
  return dir === "asc" ? comparator : (a, b) => -comparator(a, b);
}

function sortTracks(tracks: Track[], sort: TrackSortState): Track[] {
  const sorted = [...tracks];
  sorted.sort(directed(COMPARATORS[sort.key], sort.dir));
  return sorted;
}

/** Sections and albums read alphabetically; "Recently Added" reorders the
 * headers too, otherwise the newest tracks stay buried mid-list. `newest` is
 * evaluated once per item up front — inside the comparator it would rescan
 * each group's tracks on every comparison. */
function orderGroups<T>(
  items: T[],
  sort: TrackSortState,
  newest: (item: T) => number | null,
  title: (item: T) => string,
): T[] {
  const ordered = [...items];
  let compare: (a: T, b: T) => number;
  if (sort.key === "recentlyAdded") {
    const newestOf = new Map<T, number | null>(items.map((i) => [i, newest(i)]));
    compare = (a, b) => {
      const x = newestOf.get(a) ?? null;
      const y = newestOf.get(b) ?? null;
      if (x !== null && y !== null && x !== y) return y - x;
      if (x === null && y !== null) return 1;
      if (x !== null && y === null) return -1;
      return collator.compare(title(a), title(b));
    };
  } else {
    compare = (a, b) => collator.compare(title(a), title(b));
  }
  // Headers follow the direction too. A descending sort that left A–Z headers
  // above descending tracks would be two orders on screen at once, and the
  // arrow in the heading would be describing only half the list.
  ordered.sort(sort.dir === "asc" ? compare : (a, b) => -compare(a, b));
  return ordered;
}

function albumSubgroups(tracks: Track[], groupId: string, sort: TrackSortState): AlbumSubgroup[] {
  const buckets = new Map<string, { title: string; tracks: Track[] }>();
  for (const track of tracks) {
    const album = track.album || "Unknown Album";
    const key = album.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { title: album, tracks: [] };
      buckets.set(key, bucket);
    }
    bucket.tracks.push(track);
  }
  const subgroups = [...buckets.entries()].map(([key, bucket]) => ({
    // Scoped to the artist so "Greatest Hits" under two artists collapses
    // independently.
    id: `${groupId}\u0001${key}`,
    title: bucket.title,
    tracks: sortTracks(bucket.tracks, sort),
    artTrackId: bucket.tracks.find((t) => t.hasArtwork)?.id ?? null,
    missingArtCount: bucket.tracks.filter((t) => !t.hasArtwork).length,
  }));
  return orderGroups(subgroups, sort, (s) => newestDate(s.tracks), (s) => s.title);
}

function sectionKey(track: Track, grouping: TrackGrouping): { key: string; title: string } {
  switch (grouping) {
    case "artist": {
      const artist = track.artist || "Unknown Artist";
      return { key: artist.toLowerCase(), title: artist };
    }
    case "album": {
      // Album titles repeat across artists ("Greatest Hits"), so albums are
      // keyed by artist too and the header spells both out.
      const album = track.album || "Unknown Album";
      const artist = track.artist || "Unknown Artist";
      return {
        key: `${artist.toLowerCase()}\u0001${album.toLowerCase()}`,
        title: `${album} — ${artist}`,
      };
    }
    case "genre": {
      const genre = track.genre || "No Genre";
      return { key: genre.toLowerCase(), title: genre };
    }
    case "none":
      return { key: "all", title: "All Tracks" };
  }
}

export function groupTracks(
  tracks: Track[],
  grouping: TrackGrouping,
  sort: TrackSortState,
  search: string,
): TrackGroup[] {
  const lowered = search.toLowerCase();
  const filtered = search ? tracks.filter((t) => matchesLower(t, lowered)) : tracks;

  if (grouping === "none") {
    return [
      {
        id: "all",
        title: "All Tracks",
        tracks: sortTracks(filtered, sort),
        albums: null,
        artTrackId: null,
      },
    ];
  }

  const buckets = new Map<string, { title: string; tracks: Track[] }>();
  for (const track of filtered) {
    const { key, title } = sectionKey(track, grouping);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { title, tracks: [] };
      buckets.set(key, bucket);
    }
    bucket.tracks.push(track);
  }

  const groups = [...buckets.entries()].map(([key, bucket]) => {
    const albums = grouping === "artist" ? albumSubgroups(bucket.tracks, key, sort) : null;
    const artTrackId =
      albums?.find((a) => a.artTrackId !== null)?.artTrackId ??
      bucket.tracks.find((t) => t.hasArtwork)?.id ??
      null;
    return {
      id: key,
      title: bucket.title,
      // When albums exist they own the render order, and every consumer of
      // group.tracks (counts, select-all, newest-date) is order-insensitive —
      // a second sort over the same tracks would be pure waste.
      tracks: albums ? bucket.tracks : sortTracks(bucket.tracks, sort),
      albums,
      artTrackId,
    };
  });

  // g.tracks always holds the group's full track set — albums merely
  // partition it — so no flatMap is needed to find the newest date.
  return orderGroups(groups, sort, (g) => newestDate(g.tracks), (g) => g.title);
}

/** Narrows an already-grouped, already-sorted structure to the tracks
 * matching `search`. This is the per-keystroke path: groupTracks pays the
 * Intl.Collator sorts, which a query can never reorder, so a keystroke costs
 * one linear haystack scan instead of re-sorting the whole library. Filtering
 * preserves order; empty albums and groups drop out; per-album art fields are
 * recomputed from the filtered set so header counts match what's shown. */
export function filterGroups(groups: TrackGroup[], search: string): TrackGroup[] {
  if (!search) return groups;
  const lowered = search.toLowerCase();
  // Typing forward can only ever remove tracks: matching is a substring test,
  // so everything matching "beatles" already matched "beatle". Filtering the
  // previous answer instead of the whole library turns a 7-character query
  // from 7 full scans into 7 progressively tinier ones. Guarded on the input
  // being the very same grouped array — a new snapshot invalidates it.
  const base =
    lastInput === groups && lastQuery !== "" && lowered.startsWith(lastQuery)
      ? lastResult
      : groups;
  const out = filterInto(base, lowered);
  lastInput = groups;
  lastQuery = lowered;
  lastResult = out;
  return out;
}

/** Previous filter answer, for the narrowing shortcut above. */
let lastInput: TrackGroup[] | null = null;
let lastQuery = "";
let lastResult: TrackGroup[] = [];

function filterInto(groups: TrackGroup[], lowered: string): TrackGroup[] {
  const out: TrackGroup[] = [];

  for (const group of groups) {
    if (group.albums) {
      let albums: AlbumSubgroup[] | null = null;
      let groupTracksChanged = false;
      const keptAlbums: AlbumSubgroup[] = [];
      const keptTracks: Track[] = [];
      for (const album of group.albums) {
        const tracks = album.tracks.filter((t) => matchesLower(t, lowered));
        if (tracks.length === album.tracks.length) {
          keptAlbums.push(album);
          for (const t of tracks) keptTracks.push(t);
          continue;
        }
        groupTracksChanged = true;
        if (tracks.length === 0) continue;
        keptAlbums.push({
          ...album,
          tracks,
          artTrackId: tracks.find((t) => t.hasArtwork)?.id ?? null,
          missingArtCount: tracks.filter((t) => !t.hasArtwork).length,
        });
        for (const t of tracks) keptTracks.push(t);
      }
      if (keptAlbums.length === 0) continue;
      albums = keptAlbums;
      // Reuse the original group object when nothing inside it was filtered —
      // header memos and collapse state then see a stable identity.
      if (!groupTracksChanged && keptAlbums.length === group.albums.length) {
        out.push(group);
      } else {
        out.push({
          ...group,
          tracks: keptTracks,
          albums,
          artTrackId: keptAlbums.find((a) => a.artTrackId !== null)?.artTrackId ?? null,
        });
      }
    } else {
      const tracks = group.tracks.filter((t) => matchesLower(t, lowered));
      if (tracks.length === 0 && group.id !== "all") continue;
      out.push(
        tracks.length === group.tracks.length
          ? group
          : {
              ...group,
              tracks,
              artTrackId: tracks.find((t) => t.hasArtwork)?.id ?? null,
            },
      );
    }
  }
  return out;
}

/** One entry per rendered line, in render order — the virtualized list, the
 * shift-click range logic and "selected in sidebar order" all walk this. */
/** Every row carries its section id: the virtualized list renders rows as
 * absolutely positioned siblings, so a section is not a DOM subtree and
 * "hovering the section" can't be expressed in CSS — it's resolved by
 * comparing this id against the hovered row's. */
export type ListRow =
  | { kind: "artist"; group: TrackGroup }
  | { kind: "album"; album: AlbumSubgroup; first: boolean; groupId: string }
  | { kind: "track"; track: Track; isFirst: boolean; isSingle: boolean; groupId: string };

export function rowGroupId(row: ListRow): string {
  return row.kind === "artist" ? row.group.id : row.groupId;
}

export function flattenRows(
  groups: TrackGroup[],
  grouping: TrackGrouping,
  collapsedGroups: Set<string>,
  collapsedAlbums: Set<string>,
): ListRow[] {
  const rows: ListRow[] = [];
  const pushTracks = (tracks: Track[], groupId: string) => {
    for (let i = 0; i < tracks.length; i++) {
      rows.push({
        kind: "track",
        track: tracks[i],
        isFirst: i === 0,
        isSingle: tracks.length === 1,
        groupId,
      });
    }
  };
  for (const group of groups) {
    if (grouping === "none") {
      pushTracks(group.tracks, group.id);
      continue;
    }
    rows.push({ kind: "artist", group });
    if (collapsedGroups.has(group.id)) continue;
    if (group.albums) {
      group.albums.forEach((album, index) => {
        rows.push({ kind: "album", album, first: index === 0, groupId: group.id });
        if (!collapsedAlbums.has(album.id)) pushTracks(album.tracks, group.id);
      });
    } else {
      pushTracks(group.tracks, group.id);
    }
  }
  return rows;
}

export function visibleTrackIds(rows: ListRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind === "track") ids.push(row.track.id);
  }
  return ids;
}
