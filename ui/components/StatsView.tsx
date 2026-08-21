import { memo, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Check, ChevronDown, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
// Listening activity is off. The calendar can only be seeded from each
// track's last-played date, and the device reports time_played = 0 for every
// track we have seen, so the heatmap rendered a blank year with "0 plays" over
// a library with thousands of them. Component, store and wiring are all kept —
// uncomment this block, the memo, the prop and the render below to bring it
// back once there is a real timestamp to seed from.
// import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import { ArtworkThumb } from "@/components/ArtworkThumb";
import { Treemap } from "@/components/Treemap";
// import { readActivity } from "@/lib/activity";
import {
  artworkFetchSize,
  cachedArtwork,
  releaseArtwork,
  retainArtwork,
} from "@/lib/api";
import {
  computeStats,
  coverTrackIds,
  formatCount,
  formatListenTime,
  type ListeningStats,
  type RankedItem,
} from "@/lib/stats";
import { copyImageToClipboard, renderShareCard } from "@/lib/shareCard";
import type { Track } from "@/lib/types";
import { cn } from "@/lib/utils";

function StatsViewImpl({
  tracks,
  mountPoint,
}: {
  tracks: Track[];
  /** null when no iPod is connected. */
  mountPoint: string | null;
}) {
  const stats = useMemo(() => computeStats(tracks), [tracks]);
  // Generous pool: the wall slices to as many tiles as fit the window.
  const covers = useMemo(() => coverTrackIds(stats, 40), [stats]);
  // Keyed on tracks too: a snapshot landing while Stats is open (e.g. a sync
  // finishing) should repaint the calendar without a view switch.
  // const activity = useMemo(
  //   () => (mountPoint ? readActivity(mountPoint) : {}),
  //   [mountPoint, tracks],
  // );

  if (mountPoint === null) {
    return (
      <EmptyState
        title="No iPod connected"
        body="Connect an iPod to see listening stats. Play counts live on the device and sync into the library when it mounts."
      />
    );
  }
  if (stats.totalPlays === 0) {
    return (
      <EmptyState
        title="No plays recorded yet"
        body="Go listen to some music on the iPod, then reconnect. The device writes its Play Counts file as you listen, and Platter reads it on connect — your most-played artists, albums and tracks will appear here."
      />
    );
  }
  return (
    <StatsBody
      stats={stats}
      covers={covers}
      // activity={activity}
      deviceName={`iPod (${mountPoint})`}
    />
  );
}

/** Both props come straight off the snapshot, so this only recomputes when the
 * library actually changes — not on every keystroke in the Library tab. */
export const StatsView = memo(StatsViewImpl);

function StatsBody({
  stats,
  covers,
  // activity,
  deviceName,
}: {
  stats: ListeningStats;
  covers: string[];
  // activity: Record<string, number>;
  deviceName: string;
}) {
  const [copied, setCopied] = useState<null | boolean>(null);

  async function share() {
    // Resolve the card's covers through the shared artwork cache — same data
    // URLs the mosaic already fetched, so export doesn't re-hit the backend.
    // Retained for the duration: the fetch scheduler drops queued requests
    // nobody has declared interest in.
    const fetchCover = async (id: string): Promise<string | null> => {
      retainArtwork(id, 200);
      try {
        return await cachedArtwork(id, artworkFetchSize(200));
      } finally {
        releaseArtwork(id, 200);
      }
    };
    const urls = (
      await Promise.all(stats.topAlbums.slice(0, 5).map((a) =>
        a.artTrackId ? fetchCover(a.artTrackId) : Promise.resolve(null),
      ))
    ).filter((u): u is string => u !== null);
    const blob = await renderShareCard(stats, deviceName, urls);
    const ok = blob !== null && (await copyImageToClipboard(blob));
    setCopied(ok);
    window.setTimeout(() => setCopied(null), 1600);
  }

  const playedPct =
    stats.totalTracks > 0
      ? Math.round((stats.playedTracks / stats.totalTracks) * 100)
      : 0;
  const facts: [string, string][] = [
    ["Plays", formatCount(stats.totalPlays)],
    ["Listening time", formatListenTime(stats.listenMs)],
    ["Tracks played", `${formatCount(stats.playedTracks)} of ${formatCount(stats.totalTracks)}`],
    ["Library coverage", `${playedPct}%`],
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header sits outside the scroller, so the title and Copy Snapshot stay
          put while everything under them scrolls. */}
      <div className="shrink-0 border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-start justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="text-2xl font-semibold leading-snug text-balance">
              {formatListenTime(stats.listenMs)} of listening on this iPod
            </h1>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              {formatCount(stats.totalPlays)} plays across{" "}
              {formatCount(stats.playedTracks)} tracks — counted by the device
              itself, merged in every time it connects.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={share}
              title="Copy a PNG of these stats to the clipboard"
            >
              {copied === true ? <Check /> : <Share />}
              {copied === true ? "Copied" : "Copy Snapshot"}
            </Button>
            {copied === false && (
              <span className="text-[11px] text-destructive">
                Couldn’t write to the clipboard
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The covers are the B2C moment: a full-width seamless wall of what
            the device actually played. Everything below stays quiet. */}
        {covers.length >= 4 && <CoverWall ids={covers} />}

        <div className="mx-auto flex max-w-3xl flex-col gap-9 px-6 pt-8 pb-6">
          {/* One divided strip, Get-Info style — facts, not hero metrics. */}
          <dl className="grid grid-cols-2 divide-border overflow-hidden rounded-lg border sm:grid-cols-4 sm:divide-x">
            {facts.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5 px-4 py-3">
                <dt className="text-[11px] text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          {/* Artists lead by time, not rank: the calendar shows when the
              listening happened. topArtists stays computed for the share card. */}
          {/* <ActivityHeatmap data={activity} /> */}

          <Treemap title="Top Albums" items={stats.topAlbums} />
          <Ranking title="Top Tracks" items={stats.topTracks} showArt collapseAfter={10} />
        </div>
      </div>
    </div>
  );
}

/** A ranked bar list: each row's fill is its share of the leader's plays.
 * The narrow end floors at a visible sliver so rank 10 isn't an empty row.
 * With `collapseAfter` the tail hides behind a "show more" — expansion animates
 * via CSS grid rows (0fr→1fr), the only reliably smooth auto-height trick. */
function Ranking({
  title,
  items,
  showArt = false,
  collapseAfter,
}: {
  title: string;
  items: RankedItem[];
  showArt?: boolean;
  collapseAfter?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(...items.map((i) => i.plays), 1);
  const collateral = collapseAfter !== undefined && items.length > collapseAfter;
  const head = collateral ? items.slice(0, collapseAfter) : items;
  const tail = collateral ? items.slice(collapseAfter) : [];

  const row = (item: RankedItem, i: number) => (
    <li
      key={`${item.name}-${i}`}
      className="relative overflow-hidden rounded-md py-1 pl-1.5 pr-2"
    >
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 rounded-md bg-primary/10"
        style={{ width: `${(Math.max(0.03, item.plays / max) * 100).toFixed(2)}%` }}
      />
      <div className="relative flex items-center gap-2">
        <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
          {i + 1}
        </span>
        {/* ArtworkThumb falls back to a music-note tile for null ids, so
            rows without art keep their shape and alignment. */}
        {showArt && (
          <ArtworkThumb trackId={item.artTrackId} size={28} className="rounded" />
        )}
        <span
          className={cn(
            "min-w-0 truncate text-sm",
            i === 0 && "font-semibold",
          )}
          title={item.subtitle ? `${item.name} — ${item.subtitle}` : item.name}
        >
          {item.name}
          {item.subtitle && (
            <span className="text-muted-foreground"> — {item.subtitle}</span>
          )}
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatCount(item.plays)}
        </span>
      </div>
    </li>
  );

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      <ol className="flex flex-col gap-0.5">{head.map((item, i) => row(item, i))}</ol>
      {collateral && (
        <>
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-500 ease-out motion-reduce:transition-none",
              expanded ? "[grid-template-rows:1fr]" : "[grid-template-rows:0fr]",
            )}
          >
            <ol className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
              {tail.map((item, k) => row(item, (collapseAfter ?? 0) + k))}
            </ol>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown
              className={cn(
                "transition-transform duration-300 motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
            {expanded ? "Show less" : `Show ${tail.length} more`}
          </Button>
        </>
      )}
    </section>
  );
}

/** Full-width seamless mosaic of the most-played covers — square tiles,
 * no gaps or corner rounding. Column count follows the window width
 * (~140px tiles), so resizing adds or removes covers. */
function CoverWall({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setCols(Math.max(3, Math.round(el.clientWidth / 140)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shown = ids.slice(0, cols * 2);
  return (
    <div ref={ref} className="select-none overflow-hidden" aria-hidden>
      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {shown.map((id) => (
          <div key={id} className="aspect-square w-full overflow-hidden">
            <ArtworkThumb trackId={id} size={160} fill className="rounded-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    // h-full, not flex-1: the tab wrapper in App is a plain block, so a
    // flex-1 here resolves against nothing and the state sits at the top of
    // an otherwise empty pane. The wrapper's own height comes from being a
    // stretched flex item, which is what makes 100% meaningful.
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <BarChart3 className="size-10" />
      <p className="font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs leading-relaxed">{body}</p>
    </div>
  );
}
