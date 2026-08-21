import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMN_WIDTHS,
  FLEX_MIN_WIDTH,
  TRACK_COLUMNS,
  clampColumnWidth,
  columnGridTemplate,
  fitColumnWidths,
  fixedColumnsWidth,
  normalizeColumnWidths,
  resizeTargetOf,
  sameColumnWidths,
  withColumnWidth,
  type ColumnWidths,
} from "./columns";

describe("clampColumnWidth", () => {
  it("rounds to whole pixels and honours the column's own bounds", () => {
    expect(clampColumnWidth("artist", 137.4)).toBe(137);
    expect(clampColumnWidth("artist", 10)).toBe(56);
    expect(clampColumnWidth("artist", 9_000)).toBe(400);
    // A numeric column has a much tighter ceiling than a text one.
    expect(clampColumnWidth("year", 9_000)).toBe(120);
  });

  it("falls back to the default rather than yielding NaN", () => {
    expect(clampColumnWidth("title", Number.NaN)).toBe(DEFAULT_COLUMN_WIDTHS.title);
    expect(clampColumnWidth("title", Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_COLUMN_WIDTHS.title,
    );
  });
});

describe("normalizeColumnWidths", () => {
  it("returns the defaults for anything that isn't an object", () => {
    expect(normalizeColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(normalizeColumnWidths("120")).toEqual(DEFAULT_COLUMN_WIDTHS);
    expect(normalizeColumnWidths(undefined)).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it("keeps known widths, defaults the missing ones and drops the rest", () => {
    const widths = normalizeColumnWidths({ artist: 200, mood: 999 });
    expect(widths.artist).toBe(200);
    expect(widths.title).toBe(DEFAULT_COLUMN_WIDTHS.title);
    expect("mood" in widths).toBe(false);
  });

  it("drops the flexible column, which has no width to store", () => {
    // A build that stored one before Album became the flexible column must not
    // leave a pixel width in the widths object, where it would reach the grid
    // template as a fixed track.
    expect("album" in normalizeColumnWidths({ album: 120 })).toBe(false);
  });

  it("clamps stored values, so a hand-edited entry can't wedge a column", () => {
    expect(normalizeColumnWidths({ genre: 5_000 }).genre).toBe(400);
    expect(normalizeColumnWidths({ genre: "wide" }).genre).toBe(
      DEFAULT_COLUMN_WIDTHS.genre,
    );
  });
});

describe("columnGridTemplate", () => {
  it("gives Album the slack and every other column an explicit width", () => {
    expect(columnGridTemplate(DEFAULT_COLUMN_WIDTHS)).toBe(
      "300px 120px minmax(0, 1fr) 80px 30px 40px 40px 36px 36px 96px",
    );
  });

  it("has one track per column, in declaration order", () => {
    const tracks = columnGridTemplate(DEFAULT_COLUMN_WIDTHS).split(" ");
    // "minmax(0," and "1fr)" split apart — the flexible column costs two
    // words, the rest one.
    expect(tracks).toHaveLength(TRACK_COLUMNS.length + 1);
  });
});

describe("resizeTargetOf", () => {
  it("resizes the column a boundary is the right edge of", () => {
    expect(resizeTargetOf("title")).toEqual({ key: "title", sign: 1 });
    expect(resizeTargetOf("dateAdded")).toEqual({ key: "dateAdded", sign: 1 });
  });

  it("inverts at Album, whose edge can only move by narrowing Genre", () => {
    expect(resizeTargetOf("album")).toEqual({ key: "genre", sign: -1 });
  });
});

describe("fitColumnWidths", () => {
  const wide = (): ColumnWidths => ({
    title: 700,
    artist: 400,
    genre: 400,
    trackNumber: 120,
    year: 120,
    time: 120,
    bitrate: 120,
    plays: 120,
    dateAdded: 200,
  });

  it("leaves widths alone when Album already has its floor", () => {
    expect(fitColumnWidths(DEFAULT_COLUMN_WIDTHS, 1200)).toEqual(DEFAULT_COLUMN_WIDTHS);
  });

  it("gives Album its floor back when the fixed columns have eaten the row", () => {
    // The state a real drag reached: fixed columns exactly filling the box.
    const starved: ColumnWidths = {
      title: 400,
      artist: 71,
      genre: 186,
      trackNumber: 120,
      year: 120,
      time: 36,
      bitrate: 120,
      plays: 36,
      dateAdded: 180,
    };
    const fitted = fitColumnWidths(starved, 958);
    expect(958 - fixedColumnsWidth(fitted)).toBeGreaterThanOrEqual(FLEX_MIN_WIDTH);
  });

  it("shrinks proportionally, keeping the order the user set", () => {
    const fitted = fitColumnWidths(wide(), 900);
    // Year and Plays were set to the same width and share a minimum, so the
    // shrink has to leave them equal.
    expect(fitted.year).toBe(fitted.plays);
    // Genre was set wider than Year and stays wider.
    expect(fitted.genre).toBeGreaterThan(fitted.year);
  });

  it("never drives a column under its own minimum", () => {
    const fitted = fitColumnWidths(wide(), 300);
    for (const col of TRACK_COLUMNS) {
      if (col.width === null) continue;
      expect(fitted[col.key as keyof ColumnWidths]).toBeGreaterThanOrEqual(col.min);
    }
  });

  it("keeps the minimums when the row is too narrow to satisfy the floor", () => {
    // Nothing sensible to return here, and returning defaults would discard
    // widths the user chose over a window they can just widen again.
    const fitted = fitColumnWidths(wide(), 100);
    expect(fitted.artist).toBe(56);
    expect(fitted.trackNumber).toBe(24);
  });

  it("does nothing before the element has been laid out", () => {
    expect(fitColumnWidths(wide(), 0)).toEqual(wide());
    expect(fitColumnWidths(wide(), Number.NaN)).toEqual(wide());
  });
});

describe("sameColumnWidths", () => {
  it("compares by value, so a no-op fit doesn't restart the render", () => {
    expect(sameColumnWidths(DEFAULT_COLUMN_WIDTHS, { ...DEFAULT_COLUMN_WIDTHS })).toBe(true);
    expect(
      sameColumnWidths(DEFAULT_COLUMN_WIDTHS, { ...DEFAULT_COLUMN_WIDTHS, artist: 121 }),
    ).toBe(false);
  });
});

describe("withColumnWidth", () => {
  it("replaces one column without disturbing the others", () => {
    const next = withColumnWidth(DEFAULT_COLUMN_WIDTHS, "time", 64);
    expect(next.time).toBe(64);
    expect(next.artist).toBe(DEFAULT_COLUMN_WIDTHS.artist);
    expect(DEFAULT_COLUMN_WIDTHS.time).toBe(40);
  });
});
