import {
  Suspense,
  lazy,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Music, Settings } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AppVersion } from "@/components/AppVersion";
import { UpdateBadge } from "@/components/UpdateBadge";
import { BulkEditPanel } from "@/components/BulkEditPanel";
import { CapacityGauge } from "@/components/CapacityGauge";
import { ImportDialog } from "@/components/ImportDialog";
import { DisconnectedView } from "@/components/DisconnectedView";
import { DriveSelect } from "@/components/DriveSelect";
import { DrivePickerDialog } from "@/components/DrivePickerDialog";
import { EjectIcon } from "@/components/EjectIcon";
import { MountPickerDialog } from "@/components/MountPickerDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { PermissionBanner, PermissionPrimer } from "@/components/PermissionPrimer";
import { ProgressBanner } from "@/components/ProgressBanner";
import { ViewTabs } from "@/components/ViewTabs";
// Paired with the commented-out heatmap in StatsView: with no reader, the
// per-connect log is a full pass over the track list writing a calendar
// nothing draws. Kept, not deleted — see the note in StatsView.
// import { recordActivity } from "@/lib/activity";
import { Toaster } from "@/components/Toaster";
import { TrackEditPanel } from "@/components/TrackEditPanel";
import { TrackList } from "@/components/TrackList";
import { api, invalidateArtwork } from "@/lib/api";
import {
  filterGroups,
  flattenRows,
  groupTracks,
  visibleTrackIds,
  type AlbumSubgroup,
  type TrackGroup,
} from "@/lib/grouping";
import { notifyIfBackground } from "@/lib/notify";
import { unsubscribe } from "@/lib/events";
import { log } from "@/lib/log";
import { toast, toastError } from "@/lib/toast";
import type {
  AppView,
  ImportOutcome,
  ImportResult,
  LibraryPatch,
  LibrarySnapshot,
  PendingImport,
  Progress,
  Track,
  TrackGrouping,
  TrackSortState,
} from "@/lib/types";
import { SIDE_PANEL_MAX_WIDTH, SIDE_PANEL_WIDTH } from "@/lib/layout";
import { readSortPrefs, writeSortPrefs, type SortPrefs } from "@/lib/sort";

// Split out of the entry chunk: neither tab is the default view, and together
// they are the bulk of the UI code. Loading them on first visit also keeps
// their mount-time work — Convert probes ffmpeg's build config, Stats fetches
// a wall of covers — off the launch path entirely.
const ConvertView = lazy(() =>
  import("@/components/ConvertView").then((m) => ({ default: m.ConvertView })),
);
const StatsView = lazy(() =>
  import("@/components/StatsView").then((m) => ({ default: m.StatsView })),
);

const EMPTY_SNAPSHOT: LibrarySnapshot = {
  mountPoint: null,
  tracks: [],
  capacity: null,
};

export default function App() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(EMPTY_SNAPSHOT);
  // A counter, not a flag: operations can overlap (a drop during an import
  // queues behind the backend mutex), and the banner must stay up until the
  // last one finishes.
  const [busyCount, setBusyCount] = useState(0);
  const busy = busyCount > 0;
  const [progress, setProgress] = useState<Progress | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  // Grouping recomputation trails typing so keystrokes stay responsive.
  const deferredSearch = useDeferredValue(search);
  const [grouping, setGrouping] = useState<TrackGrouping>(
    () => (localStorage.getItem("trackGrouping") as TrackGrouping) || "artist",
  );
  /** One sort per grouping, not one for the list. Flat view opens on artist
   * A–Z and the grouped views on album order, and switching between them must
   * not rewrite the order of the one being left; see lib/sort.ts. */
  const [sortPrefs, setSortPrefs] = useState<SortPrefs>(readSortPrefs);
  const sort = sortPrefs[grouping];
  const setSort = useCallback(
    (next: TrackSortState) => setSortPrefs((prefs) => ({ ...prefs, [grouping]: next })),
    [grouping],
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedAlbums, setCollapsedAlbums] = useState<Set<string>>(new Set());
  const [showImporter, setShowImporter] = useState(false);
  const [showMountPicker, setShowMountPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [detailWidth, setDetailWidth] = useState(SIDE_PANEL_WIDTH);
  const [view, setView] = useState<AppView>(() => {
    const stored = localStorage.getItem("appView");
    // A stale value from an older build must not blank the window.
    return stored === "library" || stored === "convert" || stored === "stats"
      ? stored
      : "library";
  });
  /** Fraction of the running conversion, surfaced on the header tab so the
   * job stays visible from the Library tab. Null when nothing is running. */
  const [convertProgress, setConvertProgress] = useState<number | null>(null);
  /** Convert mounts on first visit and stays mounted from then on — a running
   * job's queue, log and event subscriptions must survive a tab switch. Stats
   * has no such state and so is mounted only while visible. */
  const [convertMounted, setConvertMounted] = useState(view === "convert");
  useEffect(() => {
    if (view === "convert") setConvertMounted(true);
  }, [view]);
  /** Paths dropped on the window while Convert is the visible tab, handed to
   * that tab to stage. Cleared as soon as it has taken them, so the next drop
   * of the same files is still a new value. */
  const [convertDrop, setConvertDrop] = useState<string[] | null>(null);
  const takeConvertDrop = useCallback(() => setConvertDrop(null), []);
  const detailRef = useRef<HTMLDivElement>(null);

  // First-run TCC primer: shown once. Declining raises the quiet banner
  // instead; dismissing that banner is also remembered. A genuine EPERM
  // failure later still routes through the error dialog.
  const [showPermPrimer, setShowPermPrimer] = useState(
    () => localStorage.getItem("permPrimer") === null,
  );
  const [showPermBanner, setShowPermBanner] = useState(false);
  const decidePermPrimer = useCallback((accepted: boolean) => {
    localStorage.setItem("permPrimer", accepted ? "accepted" : "declined");
    setShowPermPrimer(false);
    if (!accepted && localStorage.getItem("permBanner") !== "dismissed") {
      setShowPermBanner(true);
    }
  }, []);
  const dismissPermBanner = useCallback(() => {
    localStorage.setItem("permBanner", "dismissed");
    setShowPermBanner(false);
  }, []);

  // Read inside callbacks that must not re-subscribe on every snapshot.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const isOpen = snapshot.mountPoint !== null;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  // Read by the drag-drop handler, which routes by tab and must not
  // re-subscribe every time the tab changes.
  const viewRef = useRef(view);
  viewRef.current = view;

  // Logged from the persistence effects rather than the handlers: menu,
  // keyboard shortcut and restore-at-launch all land here, so one line each
  // covers every way the setting can move. The mount run records the state the
  // session started in, which is the first thing a report needs.
  useEffect(() => {
    localStorage.setItem("trackGrouping", grouping);
    log.info("library.grouping", grouping);
  }, [grouping]);
  useEffect(() => {
    writeSortPrefs(sortPrefs);
    log.info("library.sort", `${grouping}: ${sort.key} ${sort.dir}`);
  }, [sortPrefs, grouping, sort]);
  useEffect(() => {
    localStorage.setItem("appView", view);
    log.info("view.change", view);
  }, [view]);

  // The deferred value, not the live one: this settles once when typing stops
  // instead of writing a line per keystroke.
  useEffect(() => {
    if (deferredSearch) log.info("library.search", deferredSearch);
  }, [deferredSearch]);

  // ⌘1 / ⌘2 / ⌘3 switch tabs, the way a native app's View menu would; ⌘,
  // opens Settings, which every Mac app binds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      } else if (e.key === "1") {
        e.preventDefault();
        setView("library");
      } else if (e.key === "2") {
        e.preventDefault();
        setView("convert");
      } else if (e.key === "3") {
        e.preventDefault();
        setView("stats");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const title = snapshot.mountPoint ? `iPod (${snapshot.mountPoint})` : "Platter";
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [snapshot.mountPoint]);

  // Fold each connect into the per-day activity log feeding the Stats
  // heatmap — recording here means days fill in even if the Stats view is
  // never opened on a given sync. Keyed on the mount point, not the whole
  // snapshot: play counts only ever change when a device connects (libgpod
  // merges Play Counts during itdb_parse), so re-scanning every track and
  // re-writing localStorage after each metadata edit was pure overhead.
  // useEffect(() => {
  //   if (snapshot.mountPoint) {
  //     recordActivity(snapshotRef.current.tracks, snapshot.mountPoint);
  //   }
  // }, [snapshot.mountPoint]);

  // The window starts hidden (tauri.conf.json) so launch never flashes an
  // unpainted white surface; show it once React has committed a frame.
  useEffect(() => {
    getCurrentWindow().show().catch(() => {});
  }, []);

  /** Runs a backend call with the shared busy counter and error alert. */
  const run = useCallback(async <T,>(work: Promise<T>): Promise<T | null> => {
    setBusyCount((c) => c + 1);
    setProgress(null);
    try {
      return await work;
    } catch (e) {
      setLastError(String(e));
      return null;
    } finally {
      setBusyCount((c) => c - 1);
      setProgress(null);
    }
  }, []);

  /// A conversion that landed on the iPod changed the library underneath us;
  /// re-open it so the track list and capacity reflect what is actually there.
  const reloadLibrary = useCallback(() => {
    const mount = snapshotRef.current.mountPoint;
    if (!mount) return;
    run(api.openLibrary(mount)).then((next) => {
      if (next) {
        invalidateArtwork();
        setSnapshot(next);
      }
    });
  }, [run]);

  const applySnapshot = useCallback((next: LibrarySnapshot) => {
    setSnapshot(next);
    const alive = new Set(next.tracks.map((t) => t.id));
    setSelection((prev) => new Set([...prev].filter((id) => alive.has(id))));
  }, []);

  /** Folds a mutation's patch into the existing track array. Untouched Track
   * objects keep their identity, which is what keeps the search haystacks,
   * memo'd rows and grouping caches warm — the point of patches over full
   * snapshots. */
  const applyPatch = useCallback((patch: LibraryPatch) => {
    const updated = new Map(patch.updated.map((t) => [t.id, t]));
    const removed = new Set(patch.removedIds);
    setSnapshot((prev) => ({
      ...prev,
      tracks:
        removed.size > 0
          ? prev.tracks
              .filter((t) => !removed.has(t.id))
              .map((t) => updated.get(t.id) ?? t)
          : prev.tracks.map((t) => updated.get(t.id) ?? t),
      capacity: patch.capacity ?? prev.capacity,
    }));
    if (removed.size > 0) {
      setSelection((prev) => new Set([...prev].filter((id) => !removed.has(id))));
    }
  }, []);

  // Progress events from imports and tag reads. A listen() that fails to
  // subscribe is not benign — the progress banner would just never appear —
  // so it surfaces instead of vanishing into the webview console.
  useEffect(() => {
    const unlisten = listen<Progress>("progress", (e) => setProgress(e.payload));
    unlisten.catch((e) =>
      toastError("Progress updates unavailable", String(e)),
    );
    return () => {
      void unsubscribe(unlisten);
    };
  }, []);

  // The backend writes edits to the device on a short idle timer. When that
  // background save fails (device unplugged without eject, full or failing
  // disk), the user must hear about it — their edits exist only in memory.
  useEffect(() => {
    const unlisten = listen<string>("library:flush-failed", (e) => {
      // Sticky: a failed save loses data if it scrolls away unseen.
      toast("error", "Couldn't save changes to the iPod", {
        detail: e.payload,
        sticky: true,
      });
    });
    unlisten.catch(() => {});
    return () => {
      void unsubscribe(unlisten);
    };
  }, []);

  const handleImportResult = useCallback(
    (result: ImportResult | null): ImportOutcome => {
      if (!result) return { ok: false, failedIndices: [] };
      applySnapshot(result.snapshot);
      if (result.failures.length > 0) {
        setLastError(summarizeFailures(result.failures));
        void notifyIfBackground(
          "Import finished with problems",
          `${result.imported} imported, ${result.failures.length} failed.`,
        );
      } else if (result.imported > 0) {
        // A drive-scale import runs long enough that its owner has switched
        // apps; in the foreground this stays silent (the list itself shows).
        void notifyIfBackground(
          "Import finished",
          `${result.imported} song${result.imported === 1 ? "" : "s"} added to the iPod.`,
        );
      }
      return { ok: result.failures.length === 0, failedIndices: result.failedIndices };
    },
    [applySnapshot],
  );

  // Files dropped anywhere on the window import into the library.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const kind = event.payload.type;
      if (kind === "over" || kind === "enter") {
        setIsDropTarget(true);
      } else if (kind === "drop") {
        setIsDropTarget(false);
        const paths = event.payload.paths;
        if (paths.length === 0) return;
        // A few real paths, not just a count: an import that fails on one file
        // in a folder is unreproducible without knowing what was dropped.
        const dropped = `${paths.length} — ${paths.slice(0, 3).join(", ")}${
          paths.length > 3 ? " …" : ""
        }`;
        // On Convert a drop only fills the queue. Format, bitrate and
        // destination are all still the user's to set when the files land, so
        // the gesture that imports on Library stages here and stops — nothing
        // is converted until Convert Files is pressed.
        if (viewRef.current === "convert") {
          log.info("drop.staged", dropped);
          setConvertDrop(paths);
          return;
        }
        if (!isOpenRef.current) {
          log.warn("drop.rejected", "no iPod connected");
          setLastError("Connect an iPod before adding songs.");
          return;
        }
        log.info("drop.files", dropped);
        run(api.importFiles(paths)).then(handleImportResult);
      } else {
        setIsDropTarget(false);
      }
    });
    unlisten.catch((e) =>
      toastError("Drag-and-drop import unavailable", String(e)),
    );
    return () => {
      void unsubscribe(unlisten);
    };
  }, [run, handleImportResult]);

  // At launch: if the last-connected iPod is still mounted, connect silently;
  // otherwise the disconnected empty state is already the connect surface.
  const didLaunchConnect = useRef(false);
  useEffect(() => {
    if (didLaunchConnect.current) return;
    didLaunchConnect.current = true;
    (async () => {
      const last = localStorage.getItem("lastMountPoint");
      if (last) {
        const volumes = await api.listVolumes().catch(() => []);
        if (volumes.some((v) => v.path === last)) {
          const result = await run(api.openLibrary(last));
          if (result) {
            invalidateArtwork();
            applySnapshot(result);
          }
        }
      }
      // No silent connect: the disconnected empty state is the connect surface,
      // so there's no reason to auto-open the mount-picker dialog on launch.
    })();
  }, [run, applySnapshot]);

  const connect = useCallback(
    async (mountPoint: string): Promise<boolean> => {
      const result = await run(api.openLibrary(mountPoint));
      if (!result) return false;
      invalidateArtwork();
      applySnapshot(result);
      localStorage.setItem("lastMountPoint", mountPoint);
      return true;
    },
    [run, applySnapshot],
  );

  /** After the system prompt has been approved, the volume that was blocked a
   * second ago is readable — including its iPod_Control, which is what makes
   * `isIpod` true — so the connect that failed can simply be retried instead
   * of asking the user to relaunch. */
  const reconnectAfterGrant = useCallback(
    async (volume: string | null) => {
      setLastError(null);
      setShowPermBanner(false);
      if (isOpenRef.current) return;
      const volumes = await api.listVolumes().catch(() => []);
      const ipods = volumes.filter((v) => v.isIpod);
      const target = ipods.find((v) => v.path === volume) ?? ipods[0];
      if (target) void connect(target.path);
    },
    [connect],
  );

  const eject = useCallback(async () => {
    const result = await run(api.ejectIpod());
    // Even when diskutil refuses, the backend has closed the library.
    invalidateArtwork();
    applySnapshot(result ?? EMPTY_SNAPSHOT);
  }, [run, applySnapshot]);

  /** Grouped and sorted WITHOUT the search query. Sorting is the expensive
   * half (Intl.Collator over every track), and a keystroke can't change the
   * order of anything — so the sort runs only when the library, grouping or
   * sort mode change, and each keystroke below pays one linear filter. */
  const groupedAll = useMemo(
    () => groupTracks(snapshot.tracks, grouping, sort, ""),
    [snapshot.tracks, grouping, sort],
  );

  const groups = useMemo(
    () => filterGroups(groupedAll, deferredSearch),
    [groupedAll, deferredSearch],
  );

  const rows = useMemo(
    () => flattenRows(groups, grouping, collapsedGroups, collapsedAlbums),
    [groups, grouping, collapsedGroups, collapsedAlbums],
  );

  const visibleIds = useMemo(() => visibleTrackIds(rows), [rows]);

  /** Every track in display order, IGNORING collapse state — collapsing a
   * section must not silently drop its tracks from the active selection
   * (matching the SwiftUI app, which flatMapped all groups). Search still
   * filters, because groups themselves are built from the filtered set. */
  const orderedIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of groups) {
      if (group.albums) {
        for (const album of group.albums) for (const t of album.tracks) ids.push(t.id);
      } else {
        for (const t of group.tracks) ids.push(t.id);
      }
    }
    return ids;
  }, [groups]);

  const trackById = useMemo(
    () => new Map(snapshot.tracks.map((t) => [t.id, t])),
    [snapshot.tracks],
  );

  /** Tracks the user has selected, in the order they appear in the list. */
  const selectedTracks = useMemo(
    () => orderedIds.filter((id) => selection.has(id)).map((id) => trackById.get(id)!),
    [orderedIds, selection, trackById],
  );

  /** Remount identity for the bulk editor. FNV-1a per id, folded with XOR so
   * the key — like the sorted join it replaces — is identical for the same
   * set regardless of click order, without sorting and concatenating several
   * thousand id strings on every ⌘-click. */
  const selectionKey = useMemo(() => {
    let h = 0;
    for (const id of selection) {
      let idh = 0x811c9dc5;
      for (let i = 0; i < id.length; i++) {
        idh ^= id.charCodeAt(i);
        idh = Math.imul(idh, 0x01000193);
      }
      h ^= idh;
    }
    return `${selection.size}:${(h >>> 0).toString(36)}`;
  }, [selection]);

  const handleRowClick = useCallback(
    (trackId: string, event: React.MouseEvent) => {
      setSelection((prev) => {
        if (event.shiftKey && anchorRef.current) {
          const from = visibleIds.indexOf(anchorRef.current);
          const to = visibleIds.indexOf(trackId);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            return new Set(visibleIds.slice(lo, hi + 1));
          }
        }
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(prev);
          if (next.has(trackId)) next.delete(trackId);
          else next.add(trackId);
          anchorRef.current = trackId;
          return next;
        }
        anchorRef.current = trackId;
        return new Set([trackId]);
      });
    },
    [visibleIds],
  );

  /** Select-all toggle shared by the artist and album headers: adds the whole
   * set, or clears it when everything in it is already selected. */
  const toggleTracksSelection = useCallback((tracks: Track[]) => {
    setSelection((prev) => {
      const next = new Set(prev);
      const allSelected = tracks.every((t) => next.has(t.id));
      for (const t of tracks) {
        if (allSelected) next.delete(t.id);
        else next.add(t.id);
      }
      return next;
    });
  }, []);

  const toggleAlbumSelection = useCallback(
    (album: AlbumSubgroup) => toggleTracksSelection(album.tracks),
    [toggleTracksSelection],
  );

  /** group.tracks is the artist's full set — albums only partition it. */
  const toggleGroupSelection = useCallback(
    (group: TrackGroup) => toggleTracksSelection(group.tracks),
    [toggleTracksSelection],
  );

  const deselectAll = useCallback(() => setSelection(new Set()), []);

  // useCallback'd rather than written inline at the call site: an inline arrow
  // is a new identity on every App render, which is exactly what TrackList's
  // memo exists to avoid.
  const openImporter = useCallback(() => setShowImporter(true), []);

  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAlbum = useCallback((id: string) => {
    setCollapsedAlbums((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The drag writes the width straight to the pane element; React state is
  // committed once on mouseup, so dragging costs one style write per move
  // instead of a full re-render.
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = detailRef.current?.offsetWidth ?? detailWidth;
    let latest = startWidth;
    const onMove = (ev: MouseEvent) => {
      // The floor is the width both tabs start at — see lib/layout.ts. Below
      // it the two panes would stop lining up at their narrowest, and that
      // panel is demonstrably usable there: Convert carries a form of the same
      // shape at exactly this width.
      latest = Math.min(
        SIDE_PANEL_MAX_WIDTH,
        Math.max(SIDE_PANEL_WIDTH, startWidth + (startX - ev.clientX)),
      );
      if (detailRef.current) detailRef.current.style.width = `${latest}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDetailWidth(latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const importTracks = useCallback(
    async (items: PendingImport[]): Promise<ImportOutcome> => {
      const result = await run(api.importTracks(items));
      return handleImportResult(result);
    },
    [run, handleImportResult],
  );

  const readTags = useCallback(
    (paths: string[]) => run(api.readTags(paths)),
    [run],
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* The tools row is always present: converting to a folder on the Mac is
          a legitimate use with no iPod attached, and everything left in here
          is app-wide, so switching tabs no longer reflows the row.

          Three grid columns, not a flex row with a spacer: the left zone's
          width moves (volume name, and "42 GB free" after every import) and a
          flex layout would walk the centered tabs sideways as it did. */}
      <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-1">
          <DriveSelect
            mountPoint={snapshot.mountPoint}
            busy={busy}
            onConnect={connect}
            onEject={eject}
            onConnectManually={() => setShowMountPicker(true)}
          />
          {/* Eject sits against the device picker, before the gauge. It acts
              on the device the picker names, and the gauge is a readout of
              that same device — putting the control between its subject and a
              number keeps the pair "what is connected / what you can do to it"
              adjacent, and leaves the gauge free to grow as "42.1 GB free"
              without pushing the button around. It is otherwise reachable only
              inside the drive menu, and only under the pointer at that; a
              standing button is what makes "unplug this safely" findable
              without opening a menu to look for it. */}
          {isOpen && (
            <Button
              variant="ghost"
              size="icon-lg"
              disabled={busy}
              aria-label="Eject"
              title="Disconnect and eject the iPod so you can safely unplug it"
              onClick={eject}
            >
              <EjectIcon className="size-4.5" />
            </Button>
          )}
          {isOpen && <CapacityGauge capacity={snapshot.capacity} />}
        </div>

        <ViewTabs view={view} onChange={setView} convertProgress={convertProgress} />

        <div className="flex items-center justify-end gap-1">
          <UpdateBadge />
          <AppVersion />
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Settings"
            title="App settings (⌘,)"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="size-4.5" />
          </Button>
        </div>
      </header>

      {showPermBanner && <PermissionBanner onDismiss={dismissPermBanner} />}

      <div className="relative flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 flex-1 ${view === "library" ? "" : "hidden"}`}
        >
        {isOpen ? (
          <>
            <div className="min-w-80 flex-1">
              <TrackList
                rows={rows}
                trackCount={snapshot.tracks.length}
                searchValue={search}
                searchQuery={deferredSearch}
                onSearchChange={setSearch}
                selection={selection}
                onRowClick={handleRowClick}
                collapsedGroups={collapsedGroups}
                collapsedAlbums={collapsedAlbums}
                onToggleGroup={toggleGroup}
                onToggleAlbum={toggleAlbum}
                onToggleAlbumSelection={toggleAlbumSelection}
                onToggleGroupSelection={toggleGroupSelection}
                isDropTarget={isDropTarget}
                onDeselectAll={deselectAll}
                onAdd={openImporter}
                addDisabled={!isOpen || busy}
                grouping={grouping}
                onGroupingChange={setGrouping}
                sort={sort}
                onSortChange={setSort}
              />
            </div>

            {/* One pixel in flow, eight to aim at. Convert's panel is divided
                from its queue by a plain `border-l`, and a 4px grey bar next
                to it read as a different kind of seam — a piece of furniture
                rather than an edge. The hit area is a transparent child, so it
                can overhang both neighbours without costing the row any width,
                and hovering it still lights the rule because :hover applies to
                the ancestor too. `z-10` because the pane is a later sibling
                and would otherwise paint over the half that overhangs it. */}
            <div
              className="relative z-10 w-px shrink-0 bg-border transition-colors hover:bg-primary/40"
              onMouseDown={startResize}
            >
              <div className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
            </div>

            <div
              ref={detailRef}
              className="shrink-0 overflow-hidden"
              style={{ width: detailWidth }}
            >
              {selectedTracks.length === 1 ? (
                <TrackEditPanel
                  key={selectedTracks[0].id}
                  track={selectedTracks[0]}
                  busy={busy}
                  onSave={(fields) =>
                    run(api.updateTrack(selectedTracks[0].id, fields)).then(
                      (p) => p && applyPatch(p),
                    )
                  }
                  onSetArtwork={(path) => {
                    const ids = [selectedTracks[0].id];
                    run(api.setArtwork(ids, path)).then((p) => {
                      if (p) {
                        invalidateArtwork(ids);
                        applyPatch(p);
                      }
                    });
                  }}
                  onRemove={() => {
                    const ids = [selectedTracks[0].id];
                    run(api.removeTracks(ids)).then((p) => {
                      if (p) {
                        invalidateArtwork(ids);
                        applyPatch(p);
                      }
                    });
                  }}
                />
              ) : selectedTracks.length > 1 ? (
                <BulkEditPanel
                  key={selectionKey}
                  tracks={selectedTracks}
                  busy={busy}
                  onSetFields={(fields) =>
                    run(api.setFields(selectedTracks.map((t) => t.id), fields)).then(
                      (p) => p && applyPatch(p),
                    )
                  }
                  onSetArtwork={(path) => {
                    const ids = selectedTracks.map((t) => t.id);
                    // Returned so the panel's Apply can await it and keep the
                    // button in its "Applying…" state until the art lands.
                    return run(api.setArtwork(ids, path)).then((p) => {
                      if (p) {
                        invalidateArtwork(ids);
                        applyPatch(p);
                      }
                    });
                  }}
                  onRemove={() => {
                    const ids = selectedTracks.map((t) => t.id);
                    run(api.removeTracks(ids)).then((p) => {
                      if (p) {
                        invalidateArtwork(ids);
                        applyPatch(p);
                      }
                    });
                  }}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                  <Music className="size-10" />
                  <p className="font-medium">No Track Selected</p>
                  <p className="max-w-60 text-xs">
                    Select a track to edit it, or ⌘-click several to edit them
                    together.
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <DisconnectedView
            onConnect={connect}
            onChooseManually={() => setShowMountPicker(true)}
          />
        )}
        </div>

        {/* Hidden rather than unmounted once visited: switching tabs mid-job
            must not discard the queue or the log. */}
        {convertMounted && (
          <div className={`min-h-0 flex-1 ${view === "convert" ? "" : "hidden"}`}>
            <Suspense fallback={<TabLoading />}>
              <ConvertView
                ipodMount={snapshot.mountPoint}
                onLibraryChanged={reloadLibrary}
                onProgressChange={setConvertProgress}
                droppedPaths={convertDrop}
                onDropStaged={takeConvertDrop}
                isDropTarget={isDropTarget}
              />
            </Suspense>
          </div>
        )}

        {view === "stats" && (
          <div className="min-h-0 flex-1">
            {snapshot.mountPoint === null ? (
              // The same connect flow the Library tab shows: "no iPod" is one
              // state of the app, not one per tab, and answering it with a
              // dead-end notice here would make the user switch tabs to do
              // the only thing there is to do.
              <DisconnectedView
                onConnect={connect}
                onChooseManually={() => setShowMountPicker(true)}
              />
            ) : (
              <Suspense fallback={<TabLoading />}>
                <StatsView tracks={snapshot.tracks} mountPoint={snapshot.mountPoint} />
              </Suspense>
            )}
          </div>
        )}

        <ProgressBanner busy={busy} progress={progress} />
      </div>

      <MountPickerDialog
        open={showMountPicker}
        onOpenChange={setShowMountPicker}
        onConnect={connect}
      />

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

      <ImportDialog
        open={showImporter}
        onOpenChange={setShowImporter}
        onReadTags={readTags}
        onImport={importTracks}
        onBrowseDrive={() => {
          setShowImporter(false);
          setShowDrivePicker(true);
        }}
      />

      <DrivePickerDialog
        open={showDrivePicker}
        onOpenChange={setShowDrivePicker}
        connectedMount={snapshot.mountPoint}
        onImport={async (path) => {
          // The same call a dropped folder makes, so a whole drive and a
          // dragged folder cannot diverge in behaviour.
          await run(api.importFiles([path])).then(handleImportResult);
        }}
      />

      <ErrorDialog
        error={lastError}
        onDismiss={() => setLastError(null)}
        onGranted={(volume) => void reconnectAfterGrant(volume)}
      />
      {showPermPrimer && <PermissionPrimer onDecision={decidePermPrimer} />}
      <Toaster />
    </div>
  );
}

/** A 10,000-file drive import can fail 500 ways; the dialog must summarize,
 * not scroll a wall. Count first, a preview of the causes, and the tail
 * elided. */
function summarizeFailures(failures: string[]): string {
  const PREVIEW = 20;
  if (failures.length <= PREVIEW) return failures.join("\n");
  const rest = failures.length - PREVIEW;
  return (
    `${failures.length} files couldn't be imported. First ${PREVIEW}:\n\n` +
    failures.slice(0, PREVIEW).join("\n") +
    `\n\n…and ${rest} more.`
  );
}

/** Placeholder while a tab's chunk loads. Deliberately blank: the chunk is on
 * local disk and resolves in a frame or two, so a spinner would only flash. */
function TabLoading() {
  return <div className="h-full bg-background" />;
}

/** macOS TCC blocks reads from removable volumes ("Operation not
 * permitted") until the app is granted access — the prompt can be missed or
 * silently denied, so this turns the raw failure into guided recovery. */
function errorIsVolumeAccess(error: string): boolean {
  return error.includes("Operation not permitted");
}

function ErrorDialog({
  error,
  onDismiss,
  onGranted,
}: {
  error: string | null;
  onDismiss: () => void;
  /** Access was just granted through the system prompt; the volume that
   * answered is the one worth reconnecting to. */
  onGranted: (volume: string | null) => void;
}) {
  const volumeAccess = error !== null && errorIsVolumeAccess(error);
  // The native modal is raised by a blocking read on the backend thread, so
  // this call is outstanding for exactly as long as the user stares at it.
  const [requesting, setRequesting] = useState(false);

  const requestAccess = useCallback(async () => {
    setRequesting(true);
    try {
      const result = await api.requestVolumeAccess();
      if (result.granted) {
        toast("success", "Access granted", {
          detail: "macOS is letting Platter read the iPod now.",
        });
        onGranted(result.volume);
        return;
      }
      toastError(
        result.bundled ? "macOS didn't grant access" : "A dev build can't ask for this",
        result.bundled
          ? "The prompt was declined, or no removable volume was mounted to ask about. Open System Settings to grant it by hand."
          : "The permission belongs to the terminal that launched this build, not to Platter. Grant it there, or run the bundled app.",
      );
    } catch (e) {
      toastError("Couldn't ask macOS for access", String(e));
    } finally {
      setRequesting(false);
    }
  }, [onGranted]);

  const openSettings = useCallback(() => {
    void api.openPrivacySettings().catch(() =>
      toastError(
        "Couldn't open System Settings",
        "Open it from the Apple menu, then Privacy & Security → Files & Folders.",
      ),
    );
  }, []);

  return (
    <AlertDialog open={error !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {volumeAccess ? "macOS blocked access to the iPod" : "Error"}
          </AlertDialogTitle>
          <AlertDialogDescription className="max-h-72 overflow-y-auto whitespace-pre-wrap">
            {volumeAccess
              ? `${error}\n\nmacOS asks for removable-drive access once and then remembers the answer, which is why nothing is asking now. “Allow Access” forgets that answer and puts the system's own prompt back up — approve it there and the iPod reconnects, with no relaunch.\n\nIf no prompt appears, enable Platter in System Settings under Privacy & Security → Files & Folders → Removable Volumes (or grant Full Disk Access), then quit, relaunch and reconnect.\n\nRunning a dev build from a terminal? Grant that terminal the same access instead.`
              : error}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {volumeAccess ? (
            <>
              <Button variant="ghost" onClick={onDismiss} disabled={requesting}>
                Close
              </Button>
              <Button variant="outline" onClick={openSettings} disabled={requesting}>
                Open System Settings
              </Button>
              <Button onClick={() => void requestAccess()} disabled={requesting}>
                {requesting ? "Waiting for macOS…" : "Allow Access"}
              </Button>
            </>
          ) : (
            <AlertDialogAction onClick={onDismiss}>OK</AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
