import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock,
  FolderOpen,
  Loader2,
  MinusCircle,
  Music2,
  Smartphone,
  Upload,
  X,
} from "lucide-react";
import { AddMusicButton } from "@/components/AddMusicButton";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import { SIDE_PANEL_WIDTH } from "@/lib/layout";
import { notifyIfBackground } from "@/lib/notify";
import { unsubscribe } from "@/lib/events";
// Aliased: `log` in this file is the job's own on-screen ring buffer.
import { log as sessionLog } from "@/lib/log";
import { toastError } from "@/lib/toast";
import type {
  ConvertItemBatch,
  ConvertItemStatus,
  ConvertItemUpdate,
  ConvertLogBatch,
  ConvertLogLine,
  ConvertProgress,
  Destination,
  Estimate,
  FormatOption,
  JobSummary,
  Rate,
  SourceRow,
  TargetFormat,
  TargetSpec,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Ring buffer bound. ffmpeg at -v warning is quiet per file, but a
 * thousand-file batch still outruns any DOM that keeps every line. */
const MAX_LOG_LINES = 2000;

const CBR_CHOICES = [128, 160, 192, 256, 320];

/** One grid definition for the queue's heading and its rows, so the two cannot
 * drift apart — the same arrangement the track list uses for the same reason.
 * The last column is the remove button, which has no heading. */
const QUEUE_COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_92px_78px_74px_62px_24px] items-center gap-2 px-3";

/** Exact rendered heights, in px. Measured, not guessed: py-1.5 (12) + a 16px
 * line + a 1px bottom border, and a second pinned 16px line when the row is
 * blocked. `SourcesVirtualized` sizes itself from these. */
const ROW_H = 29;
const BLOCKED_ROW_H = 45;

function defaultRate(format: TargetFormat): Rate {
  if (format === "aac") return { cbr: 256 };
  if (format === "mp3") return { cbr: 320 };
  return "lossless";
}

function rateKbps(rate: Rate): number | null {
  return typeof rate === "object" && "cbr" in rate ? rate.cbr : null;
}

function ConvertViewImpl({
  ipodMount,
  onLibraryChanged,
  onProgressChange,
  droppedPaths,
  onDropStaged,
  isDropTarget,
}: {
  /** Mount point of the open library, or null when nothing is connected. */
  ipodMount: string | null;
  /** A finished iPod-destined job changed the library; the shell reloads it. */
  onLibraryChanged: () => void;
  /** Surfaces the running job's fraction on the header tab. */
  onProgressChange: (fraction: number | null) => void;
  /** Files dropped on the window while this tab is visible. Staged, never
   * started: the settings beside the queue are what the drop is waiting on. */
  droppedPaths: string[] | null;
  /** Hands the drop back so the shell can clear it. */
  onDropStaged: () => void;
  /** Something is being dragged over the window. */
  isDropTarget: boolean;
}) {
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [format, setFormat] = useState<TargetFormat>("alac");
  const [rate, setRate] = useState<Rate>("lossless");
  const [folder, setFolder] = useState<string | null>(null);
  const [destKind, setDestKind] = useState<"folder" | "ipod">("ipod");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [log, setLog] = useState<ConvertLogLine[]>([]);
  /** Per-row job status, keyed by SourceRow.id. Kept beside the rows rather
   * than on them: an estimate refresh replaces the whole row list mid-job. */
  const [statuses, setStatuses] = useState<Map<number, ConvertItemUpdate>>(new Map());
  const [logOpen, setLogOpen] = useState(false);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target: TargetSpec = useMemo(
    // ipodSafe is forced whenever the files are headed for the device: the
    // 16-bit / 48 kHz clamp is not the user's to switch off there.
    () => ({ format, rate, ipodSafe: destKind === "ipod" || format !== "flac" }),
    [format, rate, destKind],
  );

  const destination: Destination | null = useMemo(() => {
    if (destKind === "ipod") return ipodMount ? { kind: "ipod" } : null;
    return folder ? { kind: "folder", path: folder } : null;
  }, [destKind, ipodMount, folder]);

  useEffect(() => {
    api
      .convertFormats()
      .then(setFormats)
      .catch((e) => toastError("Couldn't probe the bundled ffmpeg", String(e)));
  }, []);

  // No iPod attached means the device destination is not offered at all,
  // rather than offered and then failing.
  useEffect(() => {
    if (!ipodMount && destKind === "ipod") setDestKind("folder");
  }, [ipodMount, destKind]);

  const refreshEstimate = useCallback(async () => {
    if (rows.length === 0 || !destination) {
      setEstimate(null);
      setEstimateError(null);
      return;
    }
    try {
      const result = await api.convertEstimate(target, destination);
      setEstimate(result.estimate);
      setRows(result.rows);
      setEstimateError(null);
    } catch (e) {
      setEstimate(null);
      setEstimateError(String(e));
    }
  }, [rows.length, destination, target]);

  useEffect(() => {
    refreshEstimate();
  }, [refreshEstimate]);

  // Job events. Log lines arrive batched; the ring buffer is trimmed here
  // rather than at render so the DOM never sees the excess.
  useEffect(() => {
    const unlistenProgress = listen<ConvertProgress>("convert:progress", (e) => {
      setProgress(e.payload);
      onProgressChange(e.payload.fraction);
    });
    const unlistenLog = listen<ConvertLogBatch>("convert:log", (e) => {
      setLog((prev) => {
        const next = [...prev, ...e.payload.lines];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    });
    const unlistenItems = listen<ConvertItemBatch>("convert:items", (e) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        for (const update of e.payload.updates) next.set(update.id, update);
        return next;
      });
    });
    const unlistenDone = listen<JobSummary>("convert:done", (e) => {
      // The outcome only, never the per-file progress stream — a 5000-track
      // job would otherwise be the entire log.
      sessionLog.info(
        "convert.done",
        `${e.payload.converted} converted, ${e.payload.failed} failed${
          e.payload.cancelled ? ", cancelled" : ""
        }`,
      );
      setSummary(e.payload);
      setRunning(false);
      setProgress(null);
      onProgressChange(null);
      if (destKind === "ipod" && !e.payload.cancelled) onLibraryChanged();
      if (!e.payload.cancelled) {
        void notifyIfBackground(
          e.payload.failed > 0 ? "Conversion finished with problems" : "Conversion finished",
          `${e.payload.converted} converted${e.payload.failed > 0 ? `, ${e.payload.failed} failed` : ""}.`,
        );
      }
    });
    // A dead convert:done subscription strands the UI at running=true with no
    // way out — that one failing is worth a loud error, not a console line.
    unlistenDone.catch((e) =>
      toastError(
        "Conversion updates unavailable",
        `Job events couldn't be subscribed; restart the app before converting. ${String(e)}`,
      ),
    );
    for (const p of [unlistenProgress, unlistenLog, unlistenItems]) {
      p.catch((e) => console.error("convert event subscription failed:", e));
    }
    return () => {
      void unsubscribe(unlistenProgress);
      void unsubscribe(unlistenLog);
      void unsubscribe(unlistenItems);
      void unsubscribe(unlistenDone);
    };
  }, [destKind, onLibraryChanged, onProgressChange]);

  /** Files and a folder were two buttons only because the dialog plugin makes
   * `directory` a mode switch. NSOpenPanel does not, so this is one panel and
   * one call; the queue never cared which kind of path it was handed. */
  async function addMusic() {
    let picked: string[];
    try {
      picked = await api.pickMusic();
    } catch (e) {
      setError(String(e));
      return;
    }
    // Cancelling is not a failure, and staging nothing would clear the error
    // line for no reason.
    if (picked.length === 0) return;
    await stage(picked);
  }

  const stage = useCallback(async (paths: string[]) => {
    setAdding(true);
    setError(null);
    try {
      setRows(await api.convertAdd(paths));
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }, []);

  // A drop is the same gesture as the Add button, and does the same thing:
  // it lists the files. Starting a job off it would convert with whatever
  // format and destination happened to be selected, which is the one moment
  // the user has not looked at them yet.
  useEffect(() => {
    if (!droppedPaths || droppedPaths.length === 0) return;
    onDropStaged();
    if (running) {
      // The backend reads the queue while a job runs, so it cannot grow.
      setError("Wait for this conversion to finish before adding more files.");
      return;
    }
    void stage(droppedPaths);
  }, [droppedPaths, onDropStaged, running, stage]);

  async function chooseFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setFolder(picked);
      setDestKind("folder");
    }
  }

  async function start() {
    if (!destination) return;
    setRunning(true);
    setSummary(null);
    setLog([]);
    setStatuses(new Map());
    setError(null);
    setLogOpen(true);
    try {
      await api.convertStart(target, destination);
    } catch (e) {
      setError(String(e));
      setRunning(false);
      onProgressChange(null);
    }
  }

  // Stable identities: SourceList rows are memoized, and these callbacks are
  // their only props besides the row — an inline lambda would defeat it.
  // Both surface failure: a silently rejected remove leaves the row visible
  // and the click looking ignored.
  const removeRow = useCallback(async (id: number) => {
    try {
      setRows(await api.convertRemove([id]));
    } catch (e) {
      toastError("Couldn't remove the file", String(e));
    }
  }, []);
  const clearRows = useCallback(async () => {
    try {
      setRows(await api.convertClear());
      setStatuses(new Map());
    } catch (e) {
      toastError("Couldn't clear the queue", String(e));
    }
  }, []);

  const chosen = formats.find((f) => f.format === format);
  const blockedAll = rows.length > 0 && rows.every((r) => r.blocked !== null);
  const wontPlay = destKind === "ipod" && chosen && !chosen.ipodPlayable;
  const blockedReason =
    rows.length === 0
      ? "Add some files first."
      : !destination
        ? destKind === "ipod"
          ? "Connect an iPod, or convert to a folder instead."
          : "Choose where to save the files."
        : chosen?.unavailable
          ? chosen.unavailable
          : wontPlay
            ? `${chosen?.label} doesn't play on an iPod — choose another format or save to this Mac.`
            : blockedAll
              ? "None of these files can be converted to this format."
              : estimate?.verdict === "doesNotFit"
                ? "Not enough free space."
                : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        <SourceList
          rows={rows}
          adding={adding}
          running={running}
          statuses={statuses}
          isDropTarget={isDropTarget}
          onAddMusic={addMusic}
          onRemove={removeRow}
          onClear={clearRows}
        />

        {/* Width from the shared constant, not a utility class: Library's
            inspector opens at the same number, and the edge must not jump when
            the tabs are switched. */}
        <div
          className="flex shrink-0 flex-col gap-5 overflow-y-auto border-l p-5"
          style={{ width: SIDE_PANEL_WIDTH }}
        >
          <Section label="Format">
            <div className="grid grid-cols-2 gap-1.5">
              {formats.map((f) => (
                <FormatTile
                  key={f.format}
                  option={f}
                  selected={f.format === format}
                  kbps={
                    f.format === format
                      ? rateKbps(rate)
                      : rateKbps(defaultRate(f.format))
                  }
                  onSelect={() => {
                    setFormat(f.format);
                    setRate(defaultRate(f.format));
                  }}
                  onKbps={(k) => {
                    setFormat(f.format);
                    setRate({ cbr: k });
                  }}
                />
              ))}
            </div>
            {chosen && !chosen.lossless && (
              <p className="text-[11px] text-muted-foreground">
                Encoded with {chosen.encoder}.
              </p>
            )}
          </Section>

          <Section label="Save to">
            <div className="flex flex-col gap-1">
              <DestRow
                icon={<Smartphone className="size-3.5" />}
                title="This iPod"
                detail={ipodMount ?? "No iPod connected"}
                disabled={!ipodMount}
                selected={destKind === "ipod"}
                onSelect={() => setDestKind("ipod")}
              />
              <DestRow
                icon={<FolderOpen className="size-3.5" />}
                title="This Mac"
                detail={folder ?? "Choose a folder…"}
                selected={destKind === "folder"}
                onSelect={() => (folder ? setDestKind("folder") : chooseFolder())}
                onEdit={chooseFolder}
              />
            </div>
          </Section>

          <EstimatePanel
            estimate={estimate}
            error={estimateError}
            lossy={chosen ? !chosen.lossless : false}
          />
        </div>
      </div>

      <ConvertFooter
        running={running}
        progress={progress}
        summary={summary}
        error={error}
        blockedReason={blockedReason}
        log={log}
        logOpen={logOpen}
        onToggleLog={() => setLogOpen((v) => !v)}
        onStart={start}
        onCancel={() => api.cancelConvert()}
        fileCount={estimate?.fileCount ?? 0}
      />
    </div>
  );
}

/** This stays mounted once visited so a running job keeps its queue, log and
 * event subscriptions while the user works in another tab. memo is what stops
 * that from costing a re-render on every unrelated shell update — all three
 * props are stable identities. */
export const ConvertView = memo(ConvertViewImpl);

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function FormatTile({
  option,
  selected,
  kbps,
  onSelect,
  onKbps,
}: {
  option: FormatOption;
  selected: boolean;
  /** CBR to show in the tile's select; null for lossless formats. */
  kbps: number | null;
  onSelect: () => void;
  onKbps: (kbps: number) => void;
}) {
  const disabled = option.unavailable !== null;
  // A <select> cannot sit inside a <button>, so the tile is a clickable div
  // with the button role and the select stops clicks from bubbling into it.
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-pressed={selected}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      title={option.unavailable ?? undefined}
      className={cn(
        "flex cursor-pointer flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
        selected
          ? "border-primary bg-primary/10"
          : "border-border/60 hover:bg-muted/60",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <span className="w-full truncate font-medium">{option.label}</span>
      <span className="flex w-full items-center gap-1 text-[10px] text-muted-foreground">
        <span className="flex-1">.{option.ext}</span>
        {!option.ipodPlayable && (
          <span className="rounded bg-muted px-1 py-px text-[9px]">Mac only</span>
        )}
        {kbps !== null && !disabled && (
          <select
            value={kbps}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onKbps(Number(e.target.value))}
            className="rounded border-none bg-muted px-1 py-px text-[10px] tabular-nums text-muted-foreground outline-none"
          >
            {CBR_CHOICES.map((k) => (
              <option key={k} value={k}>
                {k} kbps
              </option>
            ))}
          </select>
        )}
      </span>
    </div>
  );
}

function DestRow({
  icon,
  title,
  detail,
  selected,
  disabled,
  onSelect,
  onEdit,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onEdit?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
        selected ? "border-primary bg-primary/10" : "border-transparent",
        disabled && "opacity-40",
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {icon}
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{title}</span>
          <span className="truncate text-[10px] text-muted-foreground">{detail}</span>
        </span>
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
        >
          Change
        </button>
      )}
    </div>
  );
}

function SourceList({
  rows,
  adding,
  running,
  statuses,
  isDropTarget,
  onAddMusic,
  onRemove,
  onClear,
}: {
  rows: SourceRow[];
  adding: boolean;
  /** Staging the queue is locked while a job reads from it. */
  running: boolean;
  statuses: Map<number, ConvertItemUpdate>;
  /** Something is being dragged over the window; the queue is where it lands. */
  isDropTarget: boolean;
  onAddMusic: () => void;
  onRemove: (id: number) => void;
  onClear: () => void;
}) {
  // One button, one panel. Files and a folder were only ever two controls
  // because the dialog plugin makes `directory` a mode switch; NSOpenPanel
  // takes canChooseFiles and canChooseDirectories independently, so the choice
  // the menu used to ask for is now made inside the picker, where the user can
  // see what they are choosing.
  //
  // The toolbar copy. The empty state renders its own `prominent` one rather
  // than reusing this: the two differ by exactly that flag, and threading it
  // through a shared element would mean building the element where the flag is
  // known, which is here twice over.
  const addMusic = <AddMusicButton onClick={onAddMusic} disabled={adding || running} />;

  return (
    // `relative` for the drag overlay below, which frames the whole queue.
    <div className="relative flex min-w-0 flex-1 flex-col">
      {/* No toolbar over an empty queue. A strip of controls above a panel whose
          whole message is "there is nothing here yet" splits the one action the
          user has into two places and puts the smaller one first. With the queue
          empty the empty state is the only thing on screen, so it carries the
          buttons; the toolbar returns the moment there is something to manage. */}
      {rows.length > 0 && (
        // Same strip as the library's: `bg-muted/30` and gap-1.5, not a bare
        // bordered row. Both sit in the same place under the same window chrome
        // and hold the same Add button, and two toolbars that differ only in
        // whether they have a background read as two different apps.
        <div className="flex items-center gap-1.5 border-b bg-muted/30 px-3 py-2">
          {addMusic}
          <div className="flex-1" />
          {adding && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <span className="text-xs tabular-nums text-muted-foreground">
            {rows.length} file{rows.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={onClear}
            disabled={running}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            Clear
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Music2 className="size-10" />}
          title="Nothing to Convert"
          body="Add audio files or a folder, or drop them on this window. Platter reads each one, works out how big the result will be, and tells you whether it fits before anything is written."
          action={
            <AddMusicButton onClick={onAddMusic} disabled={adding || running} prominent />
          }
        >
          {/* Scanning a folder can run for a while before the first row lands,
              and until it does this panel is all there is — without this the
              window sits unchanged and the click reads as having missed. */}
          {adding && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Reading files…
            </p>
          )}
        </EmptyState>
      ) : (
        <>
          {/* The queue had none. Five unlabelled columns of codec names, sample
              rates and durations leave the reader to work out which is which,
              and the track list next door labels the same kind of table. Sits
              outside the scroll container so it stays put, exactly as that one
              does. The last column is the remove button and needs no word. */}
          <div
            className={cn(
              QUEUE_COLUMNS,
              "border-b py-1 text-[11px] font-medium text-muted-foreground/80 select-none",
            )}
          >
            <span>Name</span>
            <span>Status</span>
            <span>Format</span>
            <span>Rate</span>
            <span className="text-right">Time</span>
            <span />
          </div>
          <SourcesVirtualized
            rows={rows}
            running={running}
            statuses={statuses}
            onRemove={onRemove}
          />
        </>
      )}

      {/* The same frame the track list draws, for the same reason: the drop
          has a destination, and this is it. */}
      {isDropTarget && (
        <div className="pointer-events-none absolute inset-1 rounded-lg border-2 border-dashed border-primary" />
      )}
    </div>
  );
}

/** The staged-files list must survive queues of several thousand rows, and
 * the parent re-renders on every progress tick while a job runs — so rows
 * are virtualized and memoized rather than rendered in full each time. */
function SourcesVirtualized({
  rows,
  running,
  statuses,
  onRemove,
}: {
  rows: SourceRow[];
  running: boolean;
  statuses: Map<number, ConvertItemUpdate>;
  onRemove: (id: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Exact, not estimated. A row is py-1.5 (12) + one 16px line + the 1px
    // border-b; a blocked row carries a second pinned 16px line. These used to
    // say 32 and 47 against real heights of 29 and 42, and `measureElement`
    // corrected each rendered row on the way past: the content shrank under a
    // scrollTop the browser had already clamped, the offsets stopped agreeing
    // with the scroll position, and the list drew a band of nothing where its
    // first rows belonged. Sizes the virtualizer never has to revise cannot do
    // that. Change the padding or the type here and these two numbers move.
    estimateSize: (index) => (rows[index].blocked ? BLOCKED_ROW_H : ROW_H),
    getItemKey: (index) => rows[index].id,
    overscan: 10,
  });
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          // Deliberately no `ref={virtualizer.measureElement}` — the sizes
          // above are already exact, and measuring only re-learns them while
          // installing a ResizeObserver per visible row.
          <div
            key={item.key}
            data-index={item.index}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <SourceRowView
              row={rows[item.index]}
              // A row a running job hasn't reached yet is waiting, not idle.
              status={statuses.get(rows[item.index].id) ?? (running ? QUEUED : null)}
              running={running}
              onRemove={onRemove}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stable identity: a memoized row must not re-render just because the parent
 * rebuilt this placeholder. */
const QUEUED: ConvertItemUpdate = { id: 0, status: "queued", detail: null };

/** Tones carry the outcome, not just the word.
 *
 * The two terminal successes are green — the same green in both, since "the
 * file is written" and "the file is on the device" are the same kind of answer
 * and only differ by destination. Failure keeps destructive, the skipped rows
 * elsewhere keep amber, and everything still in motion or waiting stays
 * neutral: colour that appears while a job runs would compete with the rows
 * that have actually finished.
 *
 * Emerald rather than a token: this palette has no semantic `success`, and the
 * amber used for blocked rows is spelled the same literal way. */
const DONE_TONE = "text-emerald-600 dark:text-emerald-500";

const STATUS_COPY: Record<ConvertItemStatus, { text: string; tone: string }> = {
  queued: { text: "Waiting", tone: "text-muted-foreground" },
  converting: { text: "Converting", tone: "text-foreground" },
  converted: { text: "Converted", tone: DONE_TONE },
  importing: { text: "Copying", tone: "text-foreground" },
  imported: { text: "On iPod", tone: DONE_TONE },
  failed: { text: "Failed", tone: "text-destructive" },
  cancelled: { text: "Cancelled", tone: "text-muted-foreground" },
};

function StatusIcon({ status }: { status: ConvertItemStatus }) {
  switch (status) {
    case "queued":
      return <Clock className="size-3 shrink-0" />;
    case "converting":
      return <Loader2 className="size-3 shrink-0 animate-spin" />;
    case "importing":
      return <Upload className="size-3 shrink-0 animate-pulse" />;
    case "converted":
    case "imported":
      return <Check className="size-3 shrink-0" />;
    case "failed":
      return <AlertTriangle className="size-3 shrink-0" />;
    case "cancelled":
      return <MinusCircle className="size-3 shrink-0" />;
  }
}

const SourceRowView = memo(function SourceRowView({
  row,
  status,
  running,
  onRemove,
}: {
  row: SourceRow;
  /** Null when no job has touched this row. */
  status: ConvertItemUpdate | null;
  running: boolean;
  onRemove: (id: number) => void;
}) {
  // A row the target rejects never enters the batch, so it outranks the
  // job's own "waiting" — it is not waiting for anything.
  const skipped = row.blocked !== null;
  const copy = status && !skipped ? STATUS_COPY[status.status] : null;
  return (
    <div
      className={cn(QUEUE_COLUMNS, "border-b py-1.5 text-xs", row.blocked && "opacity-60")}
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate" title={row.srcPath}>
          {row.display}
        </span>
        {row.blocked && (
          // `leading-4` is load-bearing: text-xs sets a *unitless* line-height,
          // which this 10px child inherits as a ratio and renders at 13.33px.
          // A fractional row height is one the virtualizer's exact sizes cannot
          // state, so the second line is pinned to 16px like the first.
          <span className="flex items-center gap-1 truncate text-[10px] leading-4 text-amber-600 dark:text-amber-500">
            <AlertTriangle className="size-2.5 shrink-0" />
            {row.blocked}
          </span>
        )}
      </div>
      {skipped ? (
        <span className="flex items-center gap-1 truncate text-amber-600 dark:text-amber-500">
          <MinusCircle className="size-3 shrink-0" />
          Skipped
        </span>
      ) : status && copy ? (
        <span
          className={cn("flex items-center gap-1 truncate", copy.tone)}
          title={status.detail ?? undefined}
        >
          <StatusIcon status={status.status} />
          {copy.text}
        </span>
      ) : (
        <span />
      )}
      <span className="truncate text-muted-foreground">{row.codec}</span>
      <span className="tabular-nums text-muted-foreground">
        {row.sampleRate > 0 ? `${(row.sampleRate / 1000).toFixed(1)} kHz` : "—"}
      </span>
      <span className="text-right tabular-nums text-muted-foreground">
        {row.durationS > 0 ? formatDuration(row.durationS * 1000) : "—"}
      </span>
      <button
        type="button"
        onClick={() => onRemove(row.id)}
        disabled={running}
        className="text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
        aria-label={`Remove ${row.display}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
});

const VERDICT_COPY: Record<string, { tone: string; text: string }> = {
  fits: { tone: "text-muted-foreground", text: "Fits" },
  tight: { tone: "text-amber-600 dark:text-amber-500", text: "Should fit, but it's close" },
  doesNotFit: { tone: "text-destructive", text: "Not enough free space" },
  unknown: { tone: "text-muted-foreground", text: "Can't tell — no file lengths known" },
};

function EstimatePanel({
  estimate,
  error,
  lossy,
}: {
  estimate: Estimate | null;
  error: string | null;
  lossy: boolean;
}) {
  if (error) {
    return (
      <p className="border-t pt-4 text-xs text-destructive">{error}</p>
    );
  }
  if (!estimate) {
    return (
      <p className="border-t pt-4 text-xs text-muted-foreground">
        Add files to see how much space the result needs.
      </p>
    );
  }
  const verdict = VERDICT_COPY[estimate.verdict] ?? VERDICT_COPY.unknown;
  return (
    <div className="flex flex-col gap-2 border-t pt-4 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Files</dt>
        <dd className="text-right tabular-nums">{estimate.fileCount}</dd>
        <dt className="text-muted-foreground">Length</dt>
        <dd className="text-right tabular-nums">
          {formatDuration(estimate.totalDurationS * 1000)}
        </dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd className="text-right tabular-nums">{formatBytes(estimate.sourceBytes)}</dd>
        <dt className="text-muted-foreground">Result</dt>
        <dd className="text-right tabular-nums">
          {/* "about" disappears only when the arithmetic really is exact —
              PCM containers and CBR MP3. Everything else is a band. */}
          {estimate.exact ? "" : "about "}
          {formatBytes(estimate.likelyBytes)}
        </dd>
        {!estimate.exact && (
          <>
            <dt className="text-muted-foreground">Up to</dt>
            <dd className="text-right tabular-nums">{formatBytes(estimate.highBytes)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Free</dt>
        <dd className="text-right tabular-nums">{formatBytes(estimate.destFreeBytes)}</dd>
      </dl>

      <p className={cn("font-medium", verdict.tone)}>{verdict.text}</p>

      {estimate.oversizeFiles.length > 0 && (
        <p className="text-destructive">
          {estimate.oversizeFiles.length} file
          {estimate.oversizeFiles.length === 1 ? "" : "s"} would exceed the 4 GB
          per-file limit of a FAT32 volume.
        </p>
      )}
      {estimate.notes.map((note) => (
        <p key={note} className="text-muted-foreground">
          {note}
        </p>
      ))}
      {lossy && (
        <p className="text-muted-foreground">
          Lossy encoding discards detail permanently — keep your originals.
        </p>
      )}
    </div>
  );
}

function ConvertFooter({
  running,
  progress,
  summary,
  error,
  blockedReason,
  log,
  logOpen,
  onToggleLog,
  onStart,
  onCancel,
  fileCount,
}: {
  running: boolean;
  progress: ConvertProgress | null;
  summary: JobSummary | null;
  error: string | null;
  blockedReason: string | null;
  log: ConvertLogLine[];
  logOpen: boolean;
  onToggleLog: () => void;
  onStart: () => void;
  onCancel: () => void;
  fileCount: number;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  // Pinned to the bottom unless the user has scrolled up to read something.
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  // "Finishing" is honest: once libgpod starts copying, cancelling cannot
  // undo what is already on the device.
  const finishing = progress?.phase === "importing";

  return (
    <div className="shrink-0 border-t">
      {logOpen && (
        <div
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-40 overflow-y-auto border-b bg-muted/30 px-3 py-2 font-mono text-[10px] leading-relaxed"
        >
          {log.length === 0 ? (
            <p className="text-muted-foreground">No output yet.</p>
          ) : (
            log.map((line) => (
              <div
                key={line.seq}
                className={cn(
                  "whitespace-pre-wrap break-all",
                  line.level === "error" && "text-destructive",
                  line.level === "warn" && "text-amber-600 dark:text-amber-500",
                  line.level === "cmd" && "text-muted-foreground",
                )}
              >
                {line.file ? `${line.file}: ${line.line}` : line.line}
              </div>
            ))
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={onToggleLog}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform", logOpen && "rotate-90")} />
          Log
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {running && progress ? (
            <>
              <span className="truncate text-xs text-muted-foreground">
                {finishing
                  ? "Finishing — writing to the iPod…"
                  : `Converting ${progress.done} of ${progress.total}${
                      progress.current ? ` — ${progress.current}` : ""
                    }`}
              </span>
              <Progress value={(progress.fraction ?? 0) * 100} />
            </>
          ) : summary ? (
            <span className="truncate text-xs text-muted-foreground">
              {summary.cancelled
                ? "Cancelled."
                : `${summary.converted} converted${
                    summary.failed > 0 ? `, ${summary.failed} failed` : ""
                  }${
                    summary.outputBytes > 0 ? ` · ${formatBytes(summary.outputBytes)} written` : ""
                  }`}
            </span>
          ) : (
            <span className="truncate text-xs text-muted-foreground">
              {error ?? blockedReason ?? ""}
            </span>
          )}
        </div>

        {/* Both at `lg`, not just Convert. They share one slot and swap when a
            job starts, so a smaller Cancel would resize the footer at the
            moment the user is watching it — and Cancel is the one control that
            must not move or shrink while a conversion is running. `px-6` on
            top of the size: this is the action the whole tab exists for, and
            at its natural width it read as the same weight as the log toggle
            beside it. */}
        {running ? (
          <Button
            variant="outline"
            size="lg"
            className="px-6"
            onClick={onCancel}
            disabled={finishing}
          >
            Cancel
          </Button>
        ) : (
          <Button
            size="lg"
            className="px-6"
            onClick={onStart}
            disabled={blockedReason !== null}
          >
            Convert{fileCount > 0 ? ` ${fileCount}` : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
