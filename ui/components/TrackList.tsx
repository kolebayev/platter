import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, CircleDashed, Circle, CheckCircle2, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddMusicButton } from "@/components/AddMusicButton";
import { EmptyState } from "@/components/EmptyState";
import { Highlight } from "@/components/Highlight";
import { ArtworkThumb } from "@/components/ArtworkThumb";
import { LibraryHeaderRow } from "@/components/LibraryHeaderRow";
import {
  DEFAULT_COLUMN_WIDTHS,
  FLEX_MIN_WIDTH,
  TRACK_COLUMNS,
  columnGridTemplate,
  fitColumnWidths,
  fixedColumnsWidth,
  readColumnWidths,
  resizeTargetOf,
  withColumnWidth,
  writeColumnWidths,
  type ColumnDef,
  type ColumnKey,
  type ColumnWidths,
  type ResizableColumnKey,
} from "@/lib/columns";
import { formatDate, formatDuration } from "@/lib/format";
import { log } from "@/lib/log";
import { rowGroupId, type AlbumSubgroup, type ListRow, type TrackGroup } from "@/lib/grouping";
import { isSortedBy, nextSortFor, sortsDescending } from "@/lib/sort";
import type { Track, TrackGrouping, TrackSortState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One grid definition shared by the column heading and every row — the two
 * can't drift apart. (The SwiftUI app needed runtime geometry measurement for
 * this; here it's a single class string.) The track list now sizes its columns
 * at runtime, so the widths arrive through a custom property set on the list
 * container rather than baked into the class; see `lib/columns.ts` for why. */
const COLUMNS = "grid grid-cols-[var(--track-cols)] items-center gap-2 px-4";

const ALIGN = { left: "", center: "text-center", right: "text-right" } as const;

/** The same three alignments for the heading buttons, which are flex rows
 * (label plus sort arrow) and so cannot use text-align. */
const JUSTIFY = { left: "justify-start", center: "justify-center", right: "justify-end" } as const;

/** The grid's own box, inside the `px-4` the rows and heading share. */
function contentWidth(root: HTMLElement): number {
  return root.clientWidth - 32;
}

type SelState = "all" | "some" | "none";

function TrackListImpl({
  rows,
  trackCount,
  searchValue,
  searchQuery,
  onSearchChange,
  selection,
  onRowClick,
  collapsedGroups,
  collapsedAlbums,
  onToggleGroup,
  onToggleAlbum,
  onToggleAlbumSelection,
  onToggleGroupSelection,
  isDropTarget,
  onDeselectAll,
  onAdd,
  addDisabled,
  grouping,
  onGroupingChange,
  sort,
  onSortChange,
}: {
  rows: ListRow[];
  /** Tracks on the device, before grouping or the search filter. Distinguishes
   * "this iPod is empty" from "nothing matched" — two empty lists that need
   * opposite things said about them. */
  trackCount: number;
  /** Live input value. */
  searchValue: string;
  /** Deferred value the visible rows were computed from — used for highlight
   * so marks always match the rows on screen. */
  searchQuery: string;
  onSearchChange: (value: string) => void;
  selection: Set<string>;
  onRowClick: (trackId: string, event: React.MouseEvent) => void;
  collapsedGroups: Set<string>;
  collapsedAlbums: Set<string>;
  onToggleGroup: (id: string) => void;
  onToggleAlbum: (id: string) => void;
  onToggleAlbumSelection: (album: AlbumSubgroup) => void;
  onToggleGroupSelection: (group: TrackGroup) => void;
  isDropTarget: boolean;
  /* Flat props rather than one grouped object on purpose: this component is
   * memo'd (see the note above the export) so progress ticks and dialog state
   * in App don't re-render a virtualized list of thousands of rows. An object
   * literal would be a new identity on every App render and would defeat that;
   * primitives and useCallback'd handlers do not. */
  onDeselectAll: () => void;
  onAdd: () => void;
  addDisabled: boolean;
  grouping: TrackGrouping;
  onGroupingChange: (grouping: TrackGrouping) => void;
  sort: TrackSortState;
  onSortChange: (sort: TrackSortState) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The heading's clipping box, whose scrollLeft trails the list's. */
  const headingRef = useRef<HTMLDivElement>(null);
  /** Section under the pointer. Rows are absolutely positioned siblings, so
   * hovering "the artist section and everything inside it" can't be a CSS
   * :hover on an ancestor — each row reports its section id instead. */
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);

  /** Covers on the rows, flat view only. The grouped views already put a large
   * cover in every album header, and a thumbnail on each of that album's
   * tracks would be the same picture printed a dozen times down the page. Flat
   * view has no headers, so it is the one place a row has to carry its own. */
  const showArtwork = grouping === "none";

  /** Owns the column widths; `gridRef` is the element the grid template is
   * inherited from, and the one a drag writes to directly. */
  const [widths, setWidths] = useState(readColumnWidths);
  const gridRef = useRef<HTMLDivElement>(null);

  const commitWidths = useCallback((next: ColumnWidths) => {
    setWidths(next);
    writeColumnWidths(next);
    // Once per gesture, not per pointermove — this runs on release. The
    // template rather than the object: a nested object logs as its keys, and
    // the widths are the whole point of the line.
    log.info("library.columns", columnGridTemplate(next));
  }, []);

  /** How much row there is to lay the columns out in. Observing the row and
   * not the window because the list shares its width with the inspector pane,
   * which is draggable too. */
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const root = gridRef.current;
    if (!root) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Off the observer's own delivery. Setting state here re-renders inside
      // the callback, and WebKit then reports "ResizeObserver loop completed
      // with undelivered notifications" — which main.tsx's window.onerror
      // turned into a "Something went wrong" toast at every tab switch.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = contentWidth(root);
        // A hidden tab measures zero. Keeping the last real width means
        // coming back to Library doesn't briefly fit the columns to nothing.
        if (width > 0) setRoom(width);
      });
    });
    observer.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  /** What actually gets drawn: the stored widths, narrowed only as far as this
   * row's width forces.
   *
   * Fitting is a rendering decision, never a write. Title takes the slack, so
   * "the fixed columns fit" and "Title is visible" are different claims — at
   * 958px of fixed columns in a 958px box the grid is valid and Title is zero
   * wide, its heading printed under Artist's. But a row is narrow for all
   * sorts of passing reasons (a window opening, a pane being dragged), and an
   * earlier version of this wrote the narrowed widths back: each transient
   * layout ate the user's columns a little more, irreversibly, because fitting
   * only ever shrinks. Keeping intent and display apart means widening the
   * window gives back exactly what was set. */
  const shownWidths = useMemo(() => fitColumnWidths(widths, room), [widths, room]);

  /** The width the columns actually need, including the row's own `px-4`.
   *
   * Below this the list scrolls sideways, and the number has to be *computed*
   * rather than left to the browser. Rows are absolutely positioned, so only
   * the handful currently mounted contribute any overflow: the scroll width
   * would then change every time the virtualizer swapped a row in or out, the
   * browser would re-clamp scrollLeft against the new value, and a sideways
   * scroll would visibly stutter against a target that keeps moving. Stated up
   * front, it is the same on every frame. */
  const rowMinWidth = fixedColumnsWidth(shownWidths) + FLEX_MIN_WIDTH + 32;

  const paintWidths = useCallback(
    (next: ColumnWidths, within: number) => {
      gridRef.current?.style.setProperty(
        "--track-cols",
        columnGridTemplate(fitColumnWidths(next, within)),
      );
    },
    [],
  );

  /** Pointer-driven resize. Listeners go on the handle rather than the window
   * because the handle has pointer capture: it keeps receiving moves once the
   * cursor leaves it, and a lost capture (a system gesture, a dragged-away
   * window) arrives as pointercancel, which ends the drag with what we have
   * instead of stranding the listeners.
   *
   * Nothing calls setState until the pointer comes up. React re-rendering a
   * virtualized list per pointermove is exactly what the custom property is
   * here to avoid; the DOM is written straight, and state catches up once. */
  const beginResize = useCallback(
    (key: ResizableColumnKey, sign: 1 | -1, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const startX = event.clientX;
      const startWidth = widths[key];
      let next = widths;
      handle.setPointerCapture(event.pointerId);
      const onMove = (e: PointerEvent) => {
        // Stored raw, drawn fitted. Dragging past the point where Title hits
        // its floor stops moving the edge, and the width it stopped at is
        // still remembered — widen the window and the rest of the drag is
        // there. Committing the fitted value instead would silently rewrite
        // every other column to pay for this one.
        next = withColumnWidth(widths, key, startWidth + sign * (e.clientX - startX));
        paintWidths(next, room);
      };
      const onEnd = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        commitWidths(next);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [widths, paintWidths, commitWidths],
  );

  const nudgeWidth = useCallback(
    (key: ResizableColumnKey, delta: number) =>
      commitWidths(withColumnWidth(widths, key, widths[key] + delta)),
    [widths, commitWidths],
  );

  const resetWidth = useCallback(
    (key: ResizableColumnKey) =>
      commitWidths(withColumnWidth(widths, key, DEFAULT_COLUMN_WIDTHS[key])),
    [widths, commitWidths],
  );

  const resetAllWidths = useCallback(
    () => commitWidths({ ...DEFAULT_COLUMN_WIDTHS }),
    [commitWidths],
  );


  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row.kind === "artist") return 80;
      if (row.kind === "album") return row.first ? 52 : 72;
      return showArtwork ? 33 : 29;
    },
    getItemKey: (index) => {
      const row = rows[index];
      if (row.kind === "artist") return `ar:${row.group.id}`;
      if (row.kind === "album") return `al:${row.album.id}`;
      return row.track.id;
    },
    overscan: 12,
  });

  /** Selection state per header, computed once per (rows, selection) change.
   * Inline recounting ran on EVERY render — including each hover-state change
   * as the pointer crossed rows — and a genre group can hold tens of
   * thousands of tracks. */
  const selStates = useMemo(() => {
    const selStateOf = (tracks: Track[]): SelState => {
      let selected = 0;
      for (const t of tracks) if (selection.has(t.id)) selected++;
      if (selected === tracks.length) return "all";
      return selected > 0 ? "some" : "none";
    };
    const map = new Map<string, SelState>();
    for (const row of rows) {
      if (row.kind === "artist") map.set(`ar:${row.group.id}`, selStateOf(row.group.tracks));
      else if (row.kind === "album") map.set(`al:${row.album.id}`, selStateOf(row.album.tracks));
    }
    return map;
  }, [rows, selection]);

  return (
    <div
      ref={gridRef}
      className="relative flex h-full min-w-0 flex-col"
      style={{ "--track-cols": columnGridTemplate(shownWidths) } as CSSProperties}
    >
      {/* The whole row, not just its Add button, waits for there to be music.
          Every control on it acts on a track list — search filters one, View
          groups and sorts one, Deselect clears a selection inside one — so on
          an empty iPod it is a strip of controls for a thing that does not
          exist, sitting above a placeholder whose whole job is to say so.
          Gated on trackCount rather than rows.length: a search that matches
          nothing still needs its own field to clear. */}
      {trackCount > 0 && (
        <LibraryHeaderRow
          searchValue={searchValue}
          onSearchChange={onSearchChange}
          selectedCount={selection.size}
          onDeselectAll={onDeselectAll}
          onAdd={onAdd}
          addDisabled={addDisabled}
          grouping={grouping}
          onGroupingChange={onGroupingChange}
          onResetColumns={resetAllWidths}
        />
      )}

      {/* Headings only over something to head. On an empty iPod ten labels
          across an empty pane describe a table that isn't there, and the
          resize handles under them adjust columns nobody can see.

          Two elements rather than one: the outer box clips, the inner one
          carries the grid and may be wider than that box. The heading cannot
          live inside the list's scroller — it must not scroll vertically — so
          its horizontal offset is mirrored from there by hand, below. Before
          it was clipped, a heading too wide for the window widened the whole
          document instead, and a sideways gesture slid the entire UI. */}
      <div
        ref={headingRef}
        className={cn("overflow-hidden border-b", trackCount === 0 && "hidden")}
      >
        <div
          className={cn(
            COLUMNS,
            "py-1 text-[11px] font-medium text-muted-foreground/80 select-none",
          )}
          style={{ minWidth: rowMinWidth }}
        >
          {TRACK_COLUMNS.map((col) => (
            <span key={col.key} className={cn("relative", ALIGN[col.align])}>
              <ColumnSortButton column={col} sort={sort} onSortChange={onSortChange} />
              <ColumnResizer
                column={col.key}
                label={col.label}
                onBegin={beginResize}
                onNudge={nudgeWidth}
                onReset={resetWidth}
              />
            </span>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyList
          trackCount={trackCount}
          query={searchQuery}
          onAdd={onAdd}
          addDisabled={addDisabled}
          onClearSearch={() => onSearchChange("")}
        />
      ) : null}

      <div
        ref={scrollRef}
        className={cn("flex-1 overflow-auto select-none", rows.length === 0 && "hidden")}
        onMouseLeave={() => setHoveredGroup(null)}
        onScroll={(e) => {
          // Written straight to the DOM, not through state: this fires on
          // every frame of a scroll, and re-rendering a virtualized list to
          // move a heading sideways would be the most expensive way possible
          // to set one number.
          const heading = headingRef.current;
          if (heading) heading.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() + 24, minWidth: rowMinWidth }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const groupId = rowGroupId(row);
            // Deliberately no `ref={virtualizer.measureElement}`: every row
            // height is a constant estimateSize already returns exactly, so
            // measuring only installed a ResizeObserver per visible row and
            // forced a layout read to re-learn a number we hardcoded.
            return (
              <div
                key={item.key}
                data-index={item.index}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
                onMouseEnter={() => setHoveredGroup(groupId)}
              >
                {row.kind === "artist" ? (
                  <ArtistHeader
                    group={row.group}
                    collapsed={collapsedGroups.has(row.group.id)}
                    selState={selStates.get(`ar:${row.group.id}`) ?? "none"}
                    hovered={hoveredGroup === groupId}
                    query={searchQuery}
                    onToggle={onToggleGroup}
                    onToggleSelection={onToggleGroupSelection}
                  />
                ) : row.kind === "album" ? (
                  <AlbumHeader
                    album={row.album}
                    first={row.first}
                    collapsed={collapsedAlbums.has(row.album.id)}
                    selState={selStates.get(`al:${row.album.id}`) ?? "none"}
                    hovered={hoveredGroup === groupId}
                    query={searchQuery}
                    onToggle={onToggleAlbum}
                    onToggleSelection={onToggleAlbumSelection}
                  />
                ) : (
                  <TrackRow
                    track={row.track}
                    isSingle={row.isSingle}
                    selected={selection.has(row.track.id)}
                    query={searchQuery}
                    showArtwork={showArtwork}
                    onRowClick={onRowClick}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isDropTarget && (
        <div className="pointer-events-none absolute inset-1 rounded-lg border-2 border-dashed border-primary" />
      )}
    </div>
  );
}

/* Spacing spec, carried over from the SwiftUI insets tuned by hand:
 * artist header pt-8 (32px) pb-6 (24px); album header pt-5 (20px, first album
 * 0 — the artist header's bottom already spaces it) pb-3 (12px); track rows
 * py-1 (4px). */

/** The shell re-renders on progress ticks, busy-count changes, panel resizes
 * and dialog state — none of which reach the list. Every prop below is already
 * a stable identity (memoized rows, useCallback handlers), so memo turns those
 * into no-ops. `searchValue` still changes per keystroke, which is correct:
 * the search field lives in here. */
export const TrackList = memo(TrackListImpl);

/** A column heading, which is also the control that sorts by it.
 *
 * The button fills the heading cell rather than wrapping just the label: a
 * 4-character word is a small target, and the empty half of a wide column is
 * exactly where a pointer lands. It does not swallow the resize handle, which
 * sits above it and takes its own pointer events — a press that starts on the
 * divider never reaches this button, so a drag can't end in a re-sort.
 *
 * The arrow appears only on the column being sorted by; nine permanent arrows
 * would say nothing. Under Recently Added no column carries one, which is
 * honest — that order is not any column's.
 *
 * `title` keeps the column's own hint where it has one: the tooltip explaining
 * what "Plays" counts is worth more than a second copy of "Sort by Plays",
 * which the arrow and the cursor already imply. */
function ColumnSortButton({
  column,
  sort,
  onSortChange,
}: {
  column: ColumnDef;
  sort: TrackSortState;
  onSortChange: (sort: TrackSortState) => void;
}) {
  const active = isSortedBy(column.key, sort);
  const descending = sortsDescending(sort);
  const Arrow = descending ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-0.5 truncate rounded-sm hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring",
        JUSTIFY[column.align],
        active && "text-foreground",
      )}
      title={column.hint}
      aria-label={
        active
          ? `Sort by ${column.label}, currently ${descending ? "descending" : "ascending"}`
          : `Sort by ${column.label}`
      }
      onClick={() => onSortChange(nextSortFor(column.key, sort))}
    >
      <span className="truncate">{column.label}</span>
      {active && <Arrow className="size-3 shrink-0" aria-hidden />}
    </button>
  );
}

/** The divider at a column's right edge.
 *
 * Sits in the grid gap and overhangs it slightly, so the hit target is ~10px
 * wide while the line it draws is 1px — a divider you have to aim at is worse
 * than no divider. The line is invisible until the pointer or focus is on it;
 * nine permanently drawn rules across the heading would read as a table
 * border, which this list does not otherwise have.
 *
 * Double-click restores this one column; the View menu restores them all.
 * Arrows move it 8px, shift-arrows 1px, for anyone who can't drag. */
function ColumnResizer({
  column,
  label,
  onBegin,
  onNudge,
  onReset,
}: {
  column: ColumnKey;
  label: string;
  onBegin: (
    key: ResizableColumnKey,
    sign: 1 | -1,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  onNudge: (key: ResizableColumnKey, delta: number) => void;
  onReset: (key: ResizableColumnKey) => void;
}) {
  const { key, sign } = resizeTargetOf(column);
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label} column`}
      tabIndex={0}
      className="group absolute -inset-y-1 -right-[9px] z-10 w-[10px] cursor-col-resize touch-none focus:outline-none"
      onPointerDown={(e) => onBegin(key, sign, e)}
      onDoubleClick={() => onReset(key)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 1 : 8;
        if (e.key === "ArrowLeft") onNudge(key, -sign * step);
        else if (e.key === "ArrowRight") onNudge(key, sign * step);
        else return;
        e.preventDefault();
      }}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 motion-reduce:transition-none" />
    </span>
  );
}

/** An empty list is two different situations and they need opposite things
 * said. An iPod with nothing on it is not a problem to explain — it is the
 * start of the job, so the one action that moves it forward gets the middle of
 * the pane instead of a 60px button in a toolbar. A search that matched
 * nothing is the user's own doing and already reversible; offering Add there
 * would answer a question nobody asked. */
function EmptyList({
  trackCount,
  query,
  onAdd,
  addDisabled,
  onClearSearch,
}: {
  trackCount: number;
  query: string;
  onAdd: () => void;
  addDisabled: boolean;
  onClearSearch: () => void;
}) {
  const empty = trackCount === 0;
  return (
    <EmptyState
      // No icon on the search branch: a note over "nothing matched" illustrates
      // the library, not the result, and the pane already has the query in it.
      icon={empty ? <Music className="size-10" /> : undefined}
      title={empty ? "No music on this iPod" : "No tracks match your search"}
      body={
        empty
          ? "Add MP3 or M4A files directly, or lossless files to convert on the way in. You can also drop files and folders anywhere on this window."
          : `Nothing here matches “${query}”.`
      }
      action={
        empty ? (
          <AddMusicButton onClick={onAdd} disabled={addDisabled} prominent />
        ) : (
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Clear Search
          </Button>
        )
      }
    />
  );
}

const SELECTION_ICONS = { all: CheckCircle2, some: CircleDashed, none: Circle } as const;

/** Revealed only while the pointer is inside the owning artist section. The
 * pointer-events guard matters: an invisible but clickable target sitting at
 * the right edge of a header would swallow clicks meant for its collapse
 * toggle. Keyboard focus still reaches it, and brings the visuals back. */
function SelectAllButton({
  selState,
  hovered,
  title,
  onSelect,
}: {
  selState: SelState;
  hovered: boolean;
  title: string;
  onSelect: () => void;
}) {
  const Icon = SELECTION_ICONS[selState];
  return (
    <button
      className={cn(
        // Opacity only — no transform. A control that slides in draws more
        // attention than a select-all affordance deserves, and the header's
        // baseline would visibly shift under it.
        "shrink-0 transition-opacity motion-reduce:transition-none",
        selState === "all" ? "text-primary" : "text-muted-foreground",
        // Asymmetric: quick to arrive so it feels responsive to the pointer,
        // slower to leave so crossing a gap between rows doesn't flicker.
        hovered
          ? "opacity-100 duration-150 ease-out"
          : "pointer-events-none opacity-0 duration-300 ease-in focus-visible:pointer-events-auto focus-visible:opacity-100",
      )}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <Icon className="size-4" />
    </button>
  );
}

const ArtistHeader = memo(function ArtistHeader({
  group,
  collapsed,
  selState,
  hovered,
  query,
  onToggle,
  onToggleSelection,
}: {
  group: TrackGroup;
  collapsed: boolean;
  selState: SelState;
  hovered: boolean;
  query: string;
  onToggle: (id: string) => void;
  onToggleSelection: (group: TrackGroup) => void;
}) {
  const count = group.tracks.length;
  return (
    <div
      className="flex cursor-pointer items-center gap-1.5 px-4 pt-8 pb-6"
      onClick={() => onToggle(group.id)}
    >
      <span
        className={cn(
          "font-semibold transition-colors",
          collapsed ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <Highlight text={group.title} query={query} />
      </span>
      <span className="text-xs tabular-nums text-muted-foreground/70">{count}</span>
      <div className="flex-1" />
      <SelectAllButton
        selState={selState}
        hovered={hovered}
        title="Select all tracks by this artist"
        onSelect={() => onToggleSelection(group)}
      />
    </div>
  );
});

/** Track count in both states, with the missing-art nudge appended. */
function albumSubtitle(album: AlbumSubgroup): string {
  const count = album.tracks.length;
  let text = `${count} track${count === 1 ? "" : "s"}`;
  if (album.missingArtCount > 0) {
    text += ` · ${album.missingArtCount} without art`;
  }
  return text;
}

const AlbumHeader = memo(function AlbumHeader({
  album,
  first,
  collapsed,
  selState,
  hovered,
  query,
  onToggle,
  onToggleSelection,
}: {
  album: AlbumSubgroup;
  first: boolean;
  collapsed: boolean;
  selState: SelState;
  hovered: boolean;
  query: string;
  onToggle: (id: string) => void;
  onToggleSelection: (album: AlbumSubgroup) => void;
}) {
  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-2 px-4 pb-3 text-muted-foreground",
        first ? "pt-0" : "pt-5",
      )}
      onClick={() => onToggle(album.id)}
    >
      <ArtworkThumb
        trackId={album.artTrackId}
        size={40}
        missingCount={album.missingArtCount}
        className={cn("transition-opacity", collapsed && "opacity-50")}
      />
      <div className="min-w-0 flex flex-col gap-px">
        <span className="truncate text-xs font-semibold">
          <Highlight text={album.title} query={query} />
        </span>
        <span className="text-[9px] text-muted-foreground/70">
          {albumSubtitle(album)}
        </span>
      </div>
      <div className="flex-1" />
      <SelectAllButton
        selState={selState}
        hovered={hovered}
        title="Select all tracks in this album"
        onSelect={() => onToggleSelection(album)}
      />
    </div>
  );
});

/** Rules mirror the tuned List separators: a line above the first track, one
 * between tracks (each non-first row's border-t), and one below when the
 * album is a single track. */
/** Height of the cover in a flat row. 24px is what fits between the row's own
 * `py-1` without pushing the text off its baseline, and it is served by the
 * 80px artwork rung, so it stays sharp on a retina panel. */
const ROW_ART_SIZE = 24;

const TrackRow = memo(function TrackRow({
  track,
  isSingle,
  selected,
  query,
  showArtwork,
  onRowClick,
}: {
  track: Track;
  isSingle: boolean;
  selected: boolean;
  query: string;
  /** Flat view only — see the note where TrackList computes it. */
  showArtwork: boolean;
  onRowClick: (trackId: string, event: React.MouseEvent) => void;
}) {
  return (
    <div
      className={cn(
        COLUMNS,
        "cursor-default border-t py-1",
        isSingle && "border-b",
        selected ? "bg-primary/15" : "hover:bg-muted/50",
      )}
      onClick={(e) => onRowClick(track.id, e)}
    >
      {/* The cover rides in the Title cell rather than in a column of its own:
          a column would need a heading, a width to drag and an order to sort
          by, and none of the three means anything for a picture. */}
      <span className="flex min-w-0 items-center gap-2 text-sm" title={track.title}>
        {showArtwork && (
          <ArtworkThumb trackId={track.id} size={ROW_ART_SIZE} className="shrink-0" />
        )}
        <span className="truncate">
          <Highlight text={track.title} query={query} />
        </span>
      </span>
      <span className="truncate text-xs text-muted-foreground">
        <Highlight text={track.artist} query={query} />
      </span>
      <span className="truncate text-xs text-muted-foreground">
        <Highlight text={track.album} query={query} />
      </span>
      <span className="truncate text-xs text-muted-foreground">
        <Highlight text={track.genre} query={query} />
      </span>
      <span className="text-center text-xs tabular-nums text-muted-foreground/70">
        {track.trackNumber > 0 ? track.trackNumber : "—"}
      </span>
      <span className="text-center text-xs tabular-nums text-muted-foreground/70">
        {track.year > 0 ? track.year : "—"}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground/70">
        {formatDuration(track.durationMs)}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground/70">
        {track.bitrate > 0 ? track.bitrate : "—"}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground/70">
        {track.playCount > 0 ? track.playCount : "—"}
      </span>
      <span
        className="truncate text-right text-xs tabular-nums text-muted-foreground/70"
        title={formatDate(track.dateAdded)}
      >
        {formatDate(track.dateAdded)}
      </span>
    </div>
  );
});
