import { describe, expect, it } from "vitest";
import {
  COLUMN_SORTS,
  DEFAULT_SORTS,
  isSortedBy,
  nextSortFor,
  normalizeSortPrefs,
  sortsDescending,
} from "./sort";
import { TRACK_COLUMNS } from "./columns";
import type { TrackSortState } from "./types";

describe("column headings", () => {
  it("gives every column an order to ask for", () => {
    // A heading with no sort behind it is a heading that looks broken when
    // clicked, so this has to stay exhaustive as columns are added.
    for (const column of TRACK_COLUMNS) {
      expect(COLUMN_SORTS[column.key]).toBeDefined();
    }
  });

  it("sorts the Album heading by album order, not by album title alone", () => {
    expect(COLUMN_SORTS.album).toBe("albumOrder");
  });

  it("marks the heading whose order is on screen, and only that one", () => {
    const sort: TrackSortState = { key: "plays", dir: "desc" };
    expect(isSortedBy("plays", sort)).toBe(true);
    expect(isSortedBy("title", sort)).toBe(false);
  });

  it("marks Added under Recently Added — one order, one heading", () => {
    const sort: TrackSortState = { key: "recentlyAdded", dir: "asc" };
    expect(isSortedBy("dateAdded", sort)).toBe(true);
    expect(TRACK_COLUMNS.filter((c) => isSortedBy(c.key, sort))).toHaveLength(1);
  });
});

describe("nextSortFor", () => {
  it("starts a new column ascending, whatever the previous direction was", () => {
    expect(nextSortFor("artist", { key: "title", dir: "desc" })).toEqual({
      key: "artist",
      dir: "asc",
    });
  });

  it("reverses the column already sorted by", () => {
    expect(nextSortFor("title", { key: "title", dir: "asc" })).toEqual({
      key: "title",
      dir: "desc",
    });
    expect(nextSortFor("title", { key: "title", dir: "desc" })).toEqual({
      key: "title",
      dir: "asc",
    });
  });

  it("treats the Album heading as the column already sorted under album order", () => {
    // Otherwise clicking Album twice would set the same sort twice and never
    // reverse it, because the key it asks for is not its own name.
    expect(nextSortFor("album", { key: "albumOrder", dir: "asc" })).toEqual({
      key: "albumOrder",
      dir: "desc",
    });
  });
});

describe("sortsDescending", () => {
  it("follows the direction for an ordinary key", () => {
    expect(sortsDescending({ key: "title", dir: "asc" })).toBe(false);
    expect(sortsDescending({ key: "title", dir: "desc" })).toBe(true);
  });

  it("inverts for Recently Added, whose ascending order is newest first", () => {
    // The arrow sits over a column of dates. Ascending by "recently added"
    // counts the dates DOWN, and an up arrow there would be describing the
    // sort's name rather than the column under it.
    expect(sortsDescending({ key: "recentlyAdded", dir: "asc" })).toBe(true);
    expect(sortsDescending({ key: "recentlyAdded", dir: "desc" })).toBe(false);
  });
});

describe("defaults", () => {
  it("opens flat view on artist A–Z", () => {
    expect(DEFAULT_SORTS.none).toEqual({ key: "artist", dir: "asc" });
  });

  it("opens the grouped views in album order", () => {
    for (const grouping of ["artist", "album", "genre"] as const) {
      expect(DEFAULT_SORTS[grouping]).toEqual({ key: "albumOrder", dir: "asc" });
    }
  });
});

describe("normalizeSortPrefs", () => {
  it("fills every grouping from the defaults when there is nothing stored", () => {
    expect(normalizeSortPrefs(null)).toEqual(DEFAULT_SORTS);
  });

  it("keeps what was stored", () => {
    const stored = { none: { key: "plays", dir: "desc" } };
    const prefs = normalizeSortPrefs(stored);
    expect(prefs.none).toEqual({ key: "plays", dir: "desc" });
    expect(prefs.artist).toEqual(DEFAULT_SORTS.artist);
  });

  it("falls back per field, so a half-corrupt entry costs only that field", () => {
    const prefs = normalizeSortPrefs({
      none: { key: "nonsense", dir: "desc" },
      artist: { key: "year" },
    });
    expect(prefs.none).toEqual({ key: DEFAULT_SORTS.none.key, dir: "desc" });
    expect(prefs.artist).toEqual({ key: "year", dir: "asc" });
  });

  it("survives a stored value of the wrong shape entirely", () => {
    expect(normalizeSortPrefs("garbage")).toEqual(DEFAULT_SORTS);
    expect(normalizeSortPrefs({ none: 7, artist: null })).toEqual(DEFAULT_SORTS);
  });

  it("migrates the one sort older builds stored, but only into the grouped views", () => {
    // Flat view never had a sort of its own to inherit, and giving it the
    // migrated one would take away the default that is the point of it.
    const prefs = normalizeSortPrefs(null, "recentlyAdded");
    expect(prefs.artist).toEqual({ key: "recentlyAdded", dir: "asc" });
    expect(prefs.album).toEqual({ key: "recentlyAdded", dir: "asc" });
    expect(prefs.none).toEqual(DEFAULT_SORTS.none);
  });

  it("ignores a legacy value that is not a sort key", () => {
    expect(normalizeSortPrefs(null, "whatever")).toEqual(DEFAULT_SORTS);
  });

  it("prefers a stored per-view sort over the legacy one", () => {
    const prefs = normalizeSortPrefs({ artist: { key: "title", dir: "asc" } }, "recentlyAdded");
    expect(prefs.artist).toEqual({ key: "title", dir: "asc" });
  });
});
