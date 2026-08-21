import { describe, expect, it } from "vitest";
import {
  filterGroups,
  flattenRows,
  groupTracks,
  matches,
  rowGroupId,
  visibleTrackIds,
} from "./grouping";
import { track } from "./testing";
import type { SortDirection, TrackSortKey, TrackSortState } from "./types";

/** Sorts read as one argument everywhere in the app; spelling the object out
 * at 30 call sites would bury what each test is actually about. */
const by = (key: TrackSortKey, dir: SortDirection = "asc"): TrackSortState => ({ key, dir });

// These lock in the observable contract of the grouping pipeline so the
// optimizations still queued against it — incremental re-grouping, cached sort
// keys, prefix-narrowed search, in-place snapshot patching — have something to
// fail against. Every assertion is about output, never about how it was
// computed, so a rewrite that preserves behavior stays green.

const NO_COLLAPSE = new Set<string>();

describe("groupTracks — sectioning", () => {
  const tracks = [
    track({ id: "1", title: "Alpha", artist: "Beatles", album: "Revolver", genre: "Rock" }),
    track({ id: "2", title: "Bravo", artist: "Beatles", album: "Abbey Road", genre: "Rock" }),
    track({ id: "3", title: "Charlie", artist: "Adele", album: "21", genre: "Pop" }),
  ];

  it("groups by artist and orders sections alphabetically", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    expect(groups.map((g) => g.title)).toEqual(["Adele", "Beatles"]);
  });

  it("partitions an artist into album subgroups without losing tracks", () => {
    const [, beatles] = groupTracks(tracks, "artist", by("title"), "");
    expect(beatles.albums?.map((a) => a.title)).toEqual(["Abbey Road", "Revolver"]);
    // group.tracks stays the artist's FULL set — albums merely partition it.
    // Select-all and the track counts both depend on this.
    expect(beatles.tracks).toHaveLength(2);
  });

  it("keys albums by artist so a shared title does not merge", () => {
    const shared = [
      track({ id: "1", artist: "A", album: "Greatest Hits" }),
      track({ id: "2", artist: "B", album: "Greatest Hits" }),
    ];
    const groups = groupTracks(shared, "album", by("title"), "");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.title)).toEqual([
      "Greatest Hits — A",
      "Greatest Hits — B",
    ]);
  });

  it("falls back to placeholder titles for empty fields", () => {
    const bare = [track({ id: "1" })];
    expect(groupTracks(bare, "artist", by("title"), "")[0].title).toBe("Unknown Artist");
    expect(groupTracks(bare, "genre", by("title"), "")[0].title).toBe("No Genre");
    expect(groupTracks(bare, "artist", by("title"), "")[0].albums?.[0].title).toBe(
      "Unknown Album",
    );
  });

  it("collapses to a single section when grouping is none", () => {
    const groups = groupTracks(tracks, "none", by("title"), "");
    expect(groups).toHaveLength(1);
    expect(groups[0].albums).toBeNull();
    expect(groups[0].tracks).toHaveLength(3);
  });

  it("groups case-insensitively but keeps the first spelling seen", () => {
    const mixed = [
      track({ id: "1", artist: "Beatles" }),
      track({ id: "2", artist: "BEATLES" }),
    ];
    const groups = groupTracks(mixed, "artist", by("title"), "");
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Beatles");
  });
});

describe("groupTracks — search", () => {
  const tracks = [
    track({ id: "1", title: "Yesterday", artist: "Beatles", album: "Help", genre: "Rock" }),
    track({ id: "2", title: "Hello", artist: "Adele", album: "25", genre: "Pop" }),
  ];

  it("matches case-insensitively across title, artist, album and genre", () => {
    for (const query of ["yester", "BEAT", "help", "rock"]) {
      const groups = groupTracks(tracks, "artist", by("title"), query);
      expect(groups.flatMap((g) => g.tracks).map((t) => t.id)).toEqual(["1"]);
    }
  });

  it("drops sections that end up empty", () => {
    expect(groupTracks(tracks, "artist", by("title"), "adele")).toHaveLength(1);
    expect(groupTracks(tracks, "artist", by("title"), "zzz")).toHaveLength(0);
  });

  it("an empty query filters nothing", () => {
    expect(groupTracks(tracks, "artist", by("title"), "")).toHaveLength(2);
  });

  it("matches() agrees with the filtering used by groupTracks", () => {
    expect(matches(tracks[0], "YESTER")).toBe(true);
    expect(matches(tracks[0], "adele")).toBe(false);
  });
});

describe("sorting", () => {
  it("albumOrder sorts by disc, then track number, so multi-disc sets do not interleave", () => {
    const tracks = [
      track({ id: "d2t1", album: "Set", discNumber: 2, trackNumber: 1 }),
      track({ id: "d1t2", album: "Set", discNumber: 1, trackNumber: 2 }),
      track({ id: "d1t1", album: "Set", discNumber: 1, trackNumber: 1 }),
    ];
    const [group] = groupTracks(tracks, "none", by("albumOrder"), "");
    expect(group.tracks.map((t) => t.id)).toEqual(["d1t1", "d1t2", "d2t1"]);
  });

  it("unset disc numbers sort first, leaving single-disc albums untouched", () => {
    const tracks = [
      track({ id: "disc1", album: "Set", discNumber: 1, trackNumber: 1 }),
      track({ id: "unset", album: "Set", discNumber: 0, trackNumber: 2 }),
    ];
    const [group] = groupTracks(tracks, "none", by("albumOrder"), "");
    expect(group.tracks.map((t) => t.id)).toEqual(["unset", "disc1"]);
  });

  it("title sort is numeric, not lexicographic", () => {
    const tracks = [
      track({ id: "10", title: "Track 10" }),
      track({ id: "2", title: "Track 2" }),
    ];
    const [group] = groupTracks(tracks, "none", by("title"), "");
    expect(group.tracks.map((t) => t.id)).toEqual(["2", "10"]);
  });

  it("recentlyAdded sorts newest first and pushes undated tracks last", () => {
    const tracks = [
      track({ id: "old", title: "A", dateAdded: 1000 }),
      track({ id: "none", title: "B", dateAdded: null }),
      track({ id: "new", title: "C", dateAdded: 2000 }),
    ];
    const [group] = groupTracks(tracks, "none", by("recentlyAdded"), "");
    expect(group.tracks.map((t) => t.id)).toEqual(["new", "old", "none"]);
  });

  it("recentlyAdded reorders section headers too, not just tracks", () => {
    const tracks = [
      track({ id: "1", artist: "Older", dateAdded: 1000 }),
      track({ id: "2", artist: "Newer", dateAdded: 5000 }),
    ];
    const byDate = groupTracks(tracks, "artist", by("recentlyAdded"), "");
    expect(byDate.map((g) => g.title)).toEqual(["Newer", "Older"]);
    // Any other sort leaves the headers alphabetical.
    const byTitle = groupTracks(tracks, "artist", by("title"), "");
    expect(byTitle.map((g) => g.title)).toEqual(["Newer", "Older"].sort());
  });
});

describe("sort direction", () => {
  const tracks = [
    track({ id: "a", title: "Alpha" }),
    track({ id: "b", title: "Bravo" }),
    track({ id: "c", title: "Charlie" }),
  ];

  it("descending is the ascending order reversed, tie-breaks included", () => {
    const [asc] = groupTracks(tracks, "none", by("title"), "");
    const [desc] = groupTracks(tracks, "none", by("title", "desc"), "");
    expect(desc.tracks.map((t) => t.id)).toEqual([...asc.tracks].reverse().map((t) => t.id));
  });

  it("reverses section headers too, so one order governs the whole list", () => {
    const byArtist = [
      track({ id: "1", artist: "Adele" }),
      track({ id: "2", artist: "Beatles" }),
      track({ id: "3", artist: "Chic" }),
    ];
    expect(groupTracks(byArtist, "artist", by("title", "desc"), "").map((g) => g.title)).toEqual([
      "Chic",
      "Beatles",
      "Adele",
    ]);
  });

  it("descending Recently Added is oldest first, undated tracks leading", () => {
    const dated = [
      track({ id: "old", title: "A", dateAdded: 1000 }),
      track({ id: "undated", title: "B", dateAdded: null }),
      track({ id: "new", title: "C", dateAdded: 2000 }),
    ];
    const [group] = groupTracks(dated, "none", by("recentlyAdded", "desc"), "");
    expect(group.tracks.map((t) => t.id)).toEqual(["undated", "old", "new"]);
  });
});

describe("column sorts", () => {
  // One case per key a column heading can ask for: these orders exist only
  // because a heading is clickable, so nothing else would catch them going
  // wrong.
  const ids = (sort: TrackSortState, tracks: ReturnType<typeof track>[]) =>
    groupTracks(tracks, "none", sort, "")[0].tracks.map((t) => t.id);

  it("sorts by genre, then title", () => {
    const tracks = [
      track({ id: "rock-b", title: "B", genre: "Rock" }),
      track({ id: "pop", title: "Z", genre: "Pop" }),
      track({ id: "rock-a", title: "A", genre: "Rock" }),
    ];
    expect(ids(by("genre"), tracks)).toEqual(["pop", "rock-a", "rock-b"]);
  });

  it("sorts by track number across discs", () => {
    const tracks = [
      track({ id: "d2t1", discNumber: 2, trackNumber: 1 }),
      track({ id: "d1t9", discNumber: 1, trackNumber: 9 }),
    ];
    expect(ids(by("trackNumber"), tracks)).toEqual(["d1t9", "d2t1"]);
  });

  it("sorts numeric columns by value, with unknown (0) first", () => {
    const years = [
      track({ id: "1999", year: 1999 }),
      track({ id: "unset", year: 0 }),
      track({ id: "1975", year: 1975 }),
    ];
    expect(ids(by("year"), years)).toEqual(["unset", "1975", "1999"]);

    const times = [
      track({ id: "long", durationMs: 400_000 }),
      track({ id: "short", durationMs: 90_000 }),
    ];
    expect(ids(by("time"), times)).toEqual(["short", "long"]);

    const rates = [track({ id: "320", bitrate: 320 }), track({ id: "128", bitrate: 128 })];
    expect(ids(by("bitrate"), rates)).toEqual(["128", "320"]);

    const plays = [track({ id: "many", playCount: 40 }), track({ id: "none", playCount: 0 })];
    expect(ids(by("plays"), plays)).toEqual(["none", "many"]);
  });

  it("breaks ties on title, so equal values keep a stable, readable order", () => {
    const tracks = [
      track({ id: "z", title: "Zulu", playCount: 3 }),
      track({ id: "a", title: "Alpha", playCount: 3 }),
    ];
    expect(ids(by("plays"), tracks)).toEqual(["a", "z"]);
  });
});

describe("artwork bookkeeping", () => {
  it("reports the first art-bearing track and counts the ones missing it", () => {
    const tracks = [
      track({ id: "1", artist: "A", album: "X", hasArtwork: false }),
      track({ id: "2", artist: "A", album: "X", hasArtwork: true }),
      track({ id: "3", artist: "A", album: "X", hasArtwork: false }),
    ];
    const [group] = groupTracks(tracks, "artist", by("title"), "");
    expect(group.albums?.[0].artTrackId).toBe("2");
    expect(group.albums?.[0].missingArtCount).toBe(2);
    expect(group.artTrackId).toBe("2");
  });

  it("leaves artTrackId null for a wholly artless album", () => {
    const [group] = groupTracks([track({ id: "1", artist: "A" })], "artist", by("title"), "");
    expect(group.artTrackId).toBeNull();
    expect(group.albums?.[0].artTrackId).toBeNull();
  });
});

describe("flattenRows", () => {
  const tracks = [
    track({ id: "1", artist: "A", album: "One", title: "a" }),
    track({ id: "2", artist: "A", album: "Two", title: "b" }),
  ];

  it("emits an artist header, then an album header before each album's tracks", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    const rows = flattenRows(groups, "artist", NO_COLLAPSE, NO_COLLAPSE);
    expect(rows.map((r) => r.kind)).toEqual([
      "artist",
      "album",
      "track",
      "album",
      "track",
    ]);
    // Only the first album header of a section is flagged, which is what drives
    // its reduced top spacing.
    expect(rows.filter((r) => r.kind === "album").map((r) => r.first)).toEqual([
      true,
      false,
    ]);
  });

  it("a collapsed group hides its albums and tracks but keeps its header", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    const rows = flattenRows(groups, "artist", new Set([groups[0].id]), NO_COLLAPSE);
    expect(rows.map((r) => r.kind)).toEqual(["artist"]);
  });

  it("a collapsed album hides only its own tracks", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    const firstAlbum = groups[0].albums![0].id;
    const rows = flattenRows(groups, "artist", NO_COLLAPSE, new Set([firstAlbum]));
    expect(rows.map((r) => r.kind)).toEqual(["artist", "album", "album", "track"]);
  });

  it("emits no headers when grouping is none", () => {
    const groups = groupTracks(tracks, "none", by("title"), "");
    const rows = flattenRows(groups, "none", NO_COLLAPSE, NO_COLLAPSE);
    expect(rows.every((r) => r.kind === "track")).toBe(true);
  });

  it("flags a lone track as both first and single", () => {
    const groups = groupTracks([track({ id: "1", artist: "A" })], "artist", by("title"), "");
    const rows = flattenRows(groups, "artist", NO_COLLAPSE, NO_COLLAPSE);
    const trackRow = rows.find((r) => r.kind === "track")!;
    expect(trackRow).toMatchObject({ isFirst: true, isSingle: true });
  });

  it("every row reports the section it belongs to", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    const rows = flattenRows(groups, "artist", NO_COLLAPSE, NO_COLLAPSE);
    expect(new Set(rows.map(rowGroupId))).toEqual(new Set([groups[0].id]));
  });

  it("visibleTrackIds returns only track rows, in render order", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    const rows = flattenRows(groups, "artist", NO_COLLAPSE, NO_COLLAPSE);
    expect(visibleTrackIds(rows)).toEqual(["1", "2"]);
    // Collapsing removes them from the visible set — the shift-click range and
    // the selection-preserving logic both read this.
    const collapsed = flattenRows(groups, "artist", new Set([groups[0].id]), NO_COLLAPSE);
    expect(visibleTrackIds(collapsed)).toEqual([]);
  });
});

describe("filterGroups — the per-keystroke narrowing pass", () => {
  const tracks = [
    track({ id: "1", title: "Taxman", artist: "Beatles", album: "Revolver", hasArtwork: true }),
    track({ id: "2", title: "Eleanor Rigby", artist: "Beatles", album: "Revolver" }),
    track({ id: "3", title: "Come Together", artist: "Beatles", album: "Abbey Road" }),
    track({ id: "4", title: "Hello", artist: "Adele", album: "25" }),
  ];

  it("returns the same array identity for an empty query", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    expect(filterGroups(groups, "")).toBe(groups);
  });

  it("matches groupTracks' own filtered output for every grouping mode", () => {
    // The contract that keeps this optimization honest: filtering an
    // already-grouped structure must show the same tracks in the same order
    // as grouping the filtered set, which is what the app used to do.
    for (const grouping of ["artist", "album", "genre", "none"] as const) {
      const direct = groupTracks(tracks, grouping, by("title"), "eleanor");
      const narrowed = filterGroups(groupTracks(tracks, grouping, by("title"), ""), "eleanor");
      expect(narrowed.map((g) => g.tracks.map((t) => t.id))).toEqual(
        direct.map((g) => g.tracks.map((t) => t.id)),
      );
      expect(narrowed.map((g) => g.id)).toEqual(direct.map((g) => g.id));
    }
  });

  it("drops albums and groups that no longer match", () => {
    const groups = filterGroups(groupTracks(tracks, "artist", by("title"), ""), "taxman");
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Beatles");
    expect(groups[0].albums?.map((a) => a.title)).toEqual(["Revolver"]);
    expect(groups[0].tracks.map((t) => t.id)).toEqual(["1"]);
  });

  it("recomputes album art fields from the filtered set", () => {
    const groups = filterGroups(groupTracks(tracks, "artist", by("title"), ""), "eleanor");
    const album = groups[0].albums![0];
    // Track 1 (the one with art) is filtered out, so the album has no art
    // track and one missing-art track — the header count must match rows.
    expect(album.tracks.map((t) => t.id)).toEqual(["2"]);
    expect(album.artTrackId).toBeNull();
    expect(album.missingArtCount).toBe(1);
  });

  it("reuses group objects untouched by the filter", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    const narrowed = filterGroups(groups, "e");
    // Every Beatles and Adele track matches "e", so both groups pass through
    // with identity intact — what keeps memo'd headers from re-rendering.
    expect(narrowed[0]).toBe(groups[0]);
    expect(narrowed[1]).toBe(groups[1]);
  });

  it("keeps the single 'none' group even when nothing matches", () => {
    const groups = filterGroups(groupTracks(tracks, "none", by("title"), ""), "zzz");
    expect(groups).toHaveLength(1);
    expect(groups[0].tracks).toHaveLength(0);
  });
});

// filterGroups keeps its previous answer so that extending a query narrows it
// instead of rescanning. That is module-level state shared across calls, and
// the tests above never trip it: they each build a fresh groups array, so the
// identity guard declines the shortcut every time. These drive it deliberately
// and check the fast path agrees with the slow one — a wrong answer here shows
// up as tracks missing from search results, which is invisible until it isn't.
describe("filterGroups narrowing", () => {
  const tracks = [
    track({ id: "1", title: "Yesterday", artist: "The Beatles", album: "Help" }),
    track({ id: "2", title: "Yellow Submarine", artist: "The Beatles", album: "Revolver" }),
    track({ id: "3", title: "Hello", artist: "Adele", album: "25" }),
    track({ id: "4", title: "Bea Arthur", artist: "Nobody", album: "Misc" }),
  ];
  const ids = (gs: ReturnType<typeof groupTracks>) =>
    gs.flatMap((g) => (g.albums ? g.albums.flatMap((a) => a.tracks) : g.tracks))
      .map((t) => t.id)
      .sort();

  /** Same query against a copy — a different array identity, so no shortcut. */
  const fullScan = (gs: ReturnType<typeof groupTracks>, q: string) =>
    ids(filterGroups([...gs], q));

  it("agrees with a full scan as the query is typed out", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    for (const q of ["b", "be", "bea", "beat", "beatl", "beatle", "beatles"]) {
      const expected = fullScan(groups, q);
      expect(ids(filterGroups(groups, q))).toEqual(expected);
    }
  });

  it("is correct when the query shrinks again", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    filterGroups(groups, "beatles");
    // "bea" matches more than "beatles" did, so the previous answer is not a
    // valid base — backspacing must fall back to a full scan.
    expect(ids(filterGroups(groups, "bea"))).toEqual(fullScan(groups, "bea"));
  });

  it("is correct when the query changes to something unrelated", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    filterGroups(groups, "beatles");
    expect(ids(filterGroups(groups, "adele"))).toEqual(fullScan(groups, "adele"));
  });

  it("does not carry a previous answer across a new snapshot", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    filterGroups(groups, "bea");
    const fewer = groupTracks(tracks.slice(2), "artist", by("title"), "");
    expect(ids(filterGroups(fewer, "beatles"))).toEqual(fullScan(fewer, "beatles"));
  });

  it("still returns everything for an empty query", () => {
    const groups = groupTracks(tracks, "artist", by("title"), "");
    filterGroups(groups, "beatles");
    expect(filterGroups(groups, "")).toBe(groups);
  });
});
