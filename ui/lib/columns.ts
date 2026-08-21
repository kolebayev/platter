/** Track-list column geometry.
 *
 * One definition drives the heading, the resize handles and the row template,
 * so the three can't drift apart. The widths reach the DOM as a CSS custom
 * property rather than a class: a drag then repaints by writing one property
 * on the list container, without re-rendering a virtualized list of thousands
 * of rows (TrackList sets `--track-cols` directly while the pointer is down
 * and commits to React state only on release).
 *
 * Exactly one column carries no width of its own and absorbs the slack, and
 * that is what makes a drag track the pointer: growing a fixed column pushes
 * everything to its right and shrinks the flexible one, so the boundary under
 * the cursor stays under the cursor. `minmax(0, 1fr)` rather than a floor,
 * deliberately: a floor would overflow the row horizontally once the fixed
 * columns outgrew the window, and the heading does not scroll with the list,
 * so the two would silently misalign.
 *
 * Album is that column, not Title. Title absorbing the slack meant a song name
 * was handed the entire width of a wide window — several hundred pixels for a
 * three-word string, while the album beside it truncated. Title now has an
 * ordinary width like every other column and can be dragged to whatever suits
 * the library; the leftover goes to the other long text field instead.
 *
 * The DOM-free half is what `columns.test.ts` covers; vitest runs without a
 * browser. */

export type ColumnKey =
  | "title"
  | "artist"
  | "album"
  | "genre"
  | "trackNumber"
  | "year"
  | "time"
  | "bitrate"
  | "plays"
  | "dateAdded";

/** Every column but the flexible one has an explicit, draggable width. */
export type ResizableColumnKey = Exclude<ColumnKey, "album">;

export type ColumnWidths = Record<ResizableColumnKey, number>;

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  align: "left" | "center" | "right";
  /** Null on the flexible column. */
  width: number | null;
  min: number;
  max: number;
  /** Tooltip, where the label alone doesn't say it. */
  hint?: string;
}

/** Order is the on-screen order, and `TrackRow` renders its cells in the same
 * one by hand — reorder here and you must reorder there. */
export const TRACK_COLUMNS: readonly ColumnDef[] = [
  { key: "title", label: "Title", align: "left", width: 300, min: 140, max: 700 },
  { key: "artist", label: "Artist", align: "left", width: 120, min: 56, max: 400 },
  { key: "album", label: "Album", align: "left", width: null, min: 0, max: 0 },
  { key: "genre", label: "Genre", align: "left", width: 80, min: 48, max: 400 },
  { key: "trackNumber", label: "#", align: "center", width: 30, min: 24, max: 120 },
  { key: "year", label: "Year", align: "center", width: 40, min: 32, max: 120 },
  { key: "time", label: "Time", align: "right", width: 40, min: 36, max: 120 },
  { key: "bitrate", label: "kbps", align: "right", width: 36, min: 30, max: 120 },
  {
    key: "plays",
    label: "Plays",
    align: "right",
    width: 36,
    min: 32,
    max: 120,
    hint: "Plays recorded by the iPod",
  },
  {
    key: "dateAdded",
    label: "Added",
    align: "right",
    width: 96,
    min: 64,
    max: 200,
    hint: "When the track was copied onto this iPod",
  },
];

/** The one column with no width of its own, and the one after it — the pair
 * `resizeTargetOf` needs. Derived rather than named, so moving the slack to a
 * different column is a one-line change in the table above. */
const FLEX_INDEX = TRACK_COLUMNS.findIndex((c) => c.width === null);
const FLEX_COLUMN = TRACK_COLUMNS[FLEX_INDEX];
const AFTER_FLEX = TRACK_COLUMNS[FLEX_INDEX + 1];

const RESIZABLE: readonly ColumnDef[] = TRACK_COLUMNS.filter((c) => c.width !== null);

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = Object.fromEntries(
  RESIZABLE.map((c) => [c.key, c.width]),
) as ColumnWidths;

const BOUNDS = new Map(RESIZABLE.map((c) => [c.key, c]));

/** Whole pixels, inside the column's own bounds. Anything non-finite falls
 * back to the default: a hand-edited or corrupted stored value must not leave
 * a column at NaN wide, which CSS drops and which then silently reflows every
 * column after it. */
export function clampColumnWidth(key: ResizableColumnKey, px: number): number {
  const def = BOUNDS.get(key)!;
  if (!Number.isFinite(px)) return def.width!;
  return Math.min(def.max, Math.max(def.min, Math.round(px)));
}

/** Tolerant by design — this parses whatever was in localStorage, which may
 * predate a column being added or renamed. Unknown keys are dropped, missing
 * ones take their default. */
export function normalizeColumnWidths(raw: unknown): ColumnWidths {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_COLUMN_WIDTHS };
  const source = raw as Record<string, unknown>;
  const out = {} as ColumnWidths;
  for (const def of RESIZABLE) {
    const key = def.key as ResizableColumnKey;
    const value = source[key];
    out[key] = typeof value === "number" ? clampColumnWidth(key, value) : def.width!;
  }
  return out;
}

export function columnGridTemplate(widths: ColumnWidths): string {
  return TRACK_COLUMNS.map((c) =>
    c.width === null ? "minmax(0, 1fr)" : `${widths[c.key as ResizableColumnKey]}px`,
  ).join(" ");
}

/** Which column a given boundary actually resizes, and in which direction, so
 * that the boundary follows the pointer either way.
 *
 * Every boundary is a fixed column's right edge and resizes that column — bar
 * one. The flexible column's right edge has nothing there to widen; dragging
 * it right instead *narrows* the column after it, which hands the pixels back
 * to the flexible one and moves the same boundary the same way. */
export function resizeTargetOf(key: ColumnKey): { key: ResizableColumnKey; sign: 1 | -1 } {
  return key === FLEX_COLUMN.key
    ? { key: AFTER_FLEX.key as ResizableColumnKey, sign: -1 }
    : { key: key as ResizableColumnKey, sign: 1 };
}

export function withColumnWidth(
  widths: ColumnWidths,
  key: ResizableColumnKey,
  px: number,
): ColumnWidths {
  return { ...widths, [key]: clampColumnWidth(key, px) };
}

/** What the flexible column must keep. Below this it stops being a column and
 * starts being an ellipsis, and at zero its heading prints on top of the next
 * one's. */
export const FLEX_MIN_WIDTH = 160;

/** The `gap-2` between every pair of columns, which is part of what the fixed
 * columns cost the row. */
const COLUMN_GAP = 8;

export function fixedColumnsWidth(widths: ColumnWidths): number {
  const fixed = RESIZABLE.reduce((sum, c) => sum + widths[c.key as ResizableColumnKey], 0);
  return fixed + COLUMN_GAP * (TRACK_COLUMNS.length - 1);
}

export function sameColumnWidths(a: ColumnWidths, b: ColumnWidths): boolean {
  return RESIZABLE.every((c) => a[c.key as ResizableColumnKey] === b[c.key as ResizableColumnKey]);
}

/** Shrink the fixed columns until the flexible one has its floor back.
 *
 * Per-column clamps alone can't prevent this: each of nine columns can be
 * inside its own bounds while the nine of them together leave Album nothing.
 * Only the row's width says whether a set of widths is usable, and the row's
 * width is not known where a width is chosen.
 *
 * Proportional rather than newest-first, and never below a column's own
 * minimum: the widths the user set are a statement about their relative
 * importance, and halving one of them to spare the rest would discard that.
 * A row too narrow to satisfy every minimum keeps the minimums and lets the
 * flexible column take what's left — a floor that cannot be met is not a reason to return
 * widths nobody asked for.
 *
 * `contentWidth` is the row's box inside its own padding. Zero or less means
 * the element hasn't been laid out yet; nothing to fit against, so nothing
 * changes. */
export function fitColumnWidths(widths: ColumnWidths, contentWidth: number): ColumnWidths {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return widths;

  const budget = contentWidth - FLEX_MIN_WIDTH - COLUMN_GAP * (TRACK_COLUMNS.length - 1);
  const fixed = RESIZABLE.reduce((sum, c) => sum + widths[c.key as ResizableColumnKey], 0);
  if (fixed <= budget) return widths;

  const floor = RESIZABLE.reduce((sum, c) => sum + c.min, 0);
  // Rounding is done against the running remainder rather than per column so
  // nine roundings can't add up to a column's worth of drift.
  const scale = (budget - floor) / (fixed - floor);
  const out = {} as ColumnWidths;
  for (const def of RESIZABLE) {
    const key = def.key as ResizableColumnKey;
    const over = widths[key] - def.min;
    out[key] = def.min + Math.max(0, Math.floor(over * Math.max(0, scale)));
  }
  return out;
}

// ---------------------------------------------------------------- DOM side

const STORAGE_KEY = "trackColumnWidths";

export function readColumnWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeColumnWidths(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

export function writeColumnWidths(widths: ColumnWidths) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
}
