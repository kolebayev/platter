import { useEffect, useState } from "react";
import { Check, ChevronRight, FileText } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { log } from "@/lib/log";
import { toastSuccess } from "@/lib/toast";
import type { AppIconInfo } from "@/lib/types";
import {
  readThemePref,
  setThemePref,
  THEME_LABELS,
  type ThemePref,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

/** App preferences. Currently just the icon picker — the prefs the track list
 * uses (grouping, sort, view) stay in the View menu where they're in reach of
 * the list they affect. */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [icons, setIcons] = useState<AppIconInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(() => readThemePref());
  const [logFile, setLogFile] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /* Collapsed on open, every open. Not persisted: the section is a place you
     go when something is already wrong, so the state worth restoring is the
     common one, not whatever the last bug hunt left behind. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded per open rather than once at mount: the dialog is opened rarely,
  // and this way a choice made in another window is reflected on reopen.
  useEffect(() => {
    if (!open) return;
    log.info("settings.open");
    setError(null);
    setTheme(readThemePref());
    // The dialog stays mounted between opens, so this is what actually makes
    // "collapsed by default" true on the second visit as well as the first.
    setAdvancedOpen(false);
    Promise.all([api.listAppIcons(), api.getAppIcon()])
      .then(([list, current]) => {
        setIcons(list);
        setSelected(current);
      })
      .catch((e) => setError(String(e)));
    // Its own request: the path is only ever shown, and a failure to resolve
    // it must not cost the user the icon picker.
    api.logPath().then(setLogFile, () => setLogFile(null));
  }, [open]);

  async function exportLogs() {
    // Named by date rather than time — one export per sitting is the norm,
    // and a name a user can read is a name they can attach to an issue.
    const today = new Date().toISOString().slice(0, 10);
    const dest = await save({
      defaultPath: `platter-log-${today}.txt`,
      filters: [{ name: "Log", extensions: ["txt", "log"] }],
    });
    if (!dest) return;
    setExporting(true);
    setError(null);
    try {
      await api.exportLogs(dest);
      toastSuccess("Logs exported", dest);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  async function choose(id: string | null) {
    log.info("settings.icon", id ?? "default");
    // Optimistic: the Dock swap is instant and the tile should move with it.
    const previous = selected;
    setSelected(id);
    setError(null);
    try {
      await api.setAppIcon(id);
    } catch (e) {
      setSelected(previous);
      setError(String(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">Appearance</h3>
              <DialogDescription className="text-xs">
                System follows macOS and switches with it.
              </DialogDescription>
            </div>

            {/* The macOS segmented-control idiom, as ViewTabs uses it — at
                dialog scale rather than the header's, where the tabs are the
                primary navigation and this is one setting among several. */}
            <div
              role="radiogroup"
              aria-label="Appearance"
              className="flex items-center rounded-md bg-muted/60 p-0.5"
            >
              {(Object.keys(THEME_LABELS) as ThemePref[]).map((pref) => (
                <button
                  key={pref}
                  type="button"
                  role="radio"
                  aria-checked={theme === pref}
                  onClick={() => {
                    // Repaints immediately; no await, nothing to fail.
                    setThemePref(pref);
                    setTheme(pref);
                    log.info("settings.theme", pref);
                  }}
                  className={cn(
                    "flex-1 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                    theme === pref
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {THEME_LABELS[pref]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">App Icon</h3>
              <DialogDescription className="text-xs">
                Changes the Dock and app switcher icon. Finder and Spotlight
                always show Default — macOS only lets a signed app change the
                one it draws at runtime.
              </DialogDescription>
            </div>

            {/* One row, however many icons there are — the tiles are a set of
                colourways of one image, and a row reads as that set where a
                block of rows reads as a catalogue. `flex-1` rather than a
                fixed column count so another alternate widens the row's share
                instead of starting a second line.

                That share is what sets the dialog width: each tile needs the
                64px preview plus its own p-2, so 80px, and five of them plus
                four gap-2 and the content's p-4 is 464px. 500 is that with
                enough slack that the labels don't wrap. Adding a sixth icon
                means widening this again — at 500 the tiles drop to 70px and
                the previews start to touch. The window's 900px minimum keeps
                the dialog at its full width. */}
            <div className="flex gap-2">
              {icons.map((icon) => {
                const isSelected = icon.id === selected;
                return (
                  <button
                    key={icon.id ?? "default"}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => void choose(icon.id)}
                    className={cn(
                      "relative flex flex-1 flex-col items-center gap-1.5 rounded-md border p-2 transition-colors",
                      isSelected
                        ? "border-primary bg-accent"
                        : "border-transparent hover:bg-accent/50",
                    )}
                  >
                    <img
                      src={icon.preview}
                      alt=""
                      className="size-16"
                      draggable={false}
                    />
                    <span className="text-xs text-muted-foreground">
                      {icon.label}
                    </span>
                    {isSelected && (
                      <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                        <Check className="size-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Collapsed by default. Appearance and App Icon are things you
              come here to change; the log is something you come here to fetch
              once, when told to. Leaving its three sentences of explanation
              expanded made them the bulk of the panel, which reads as the
              panel being mostly about logging. */}
          <div className="space-y-2">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
              className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/50"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform",
                  advancedOpen && "rotate-90",
                )}
              />
              <h3 className="text-sm font-medium">Advanced</h3>
            </button>

            {advancedOpen && (
              <div className="space-y-2">
                {/* Three things, in this order: what it is, that it goes
                    nowhere on its own, and what is in it. The middle sentence
                    carries the weight — a log the app collects reads as
                    telemetry unless it says outright that sending it is a
                    thing the user does by hand. And it earns the ask by
                    saying why: most bugs here are not reproducible without
                    one. The contents warning comes last, immediately above
                    the button, because that is the moment the choice is being
                    made. */}
                <DialogDescription className="text-xs">
                  Platter keeps a log of what it does, covering this session
                  only — it is cleared at every launch. Nothing is ever sent
                  anywhere: exporting the file and passing it on is entirely up
                  to you, and for most problems it is the only thing that makes
                  them fixable. It names the folders and tracks you worked
                  with.
                </DialogDescription>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={exporting}
                  onClick={() => void exportLogs()}
                >
                  <FileText />
                  {exporting ? "Exporting…" : "Export Logs…"}
                </Button>

                {/* The fallback when export itself is what's failing.
                    Wrapping rather than truncating: a path whose end is cut
                    off is the one part a user can't guess, and `break-all`
                    means no width can push it past the panel. */}
                {logFile && (
                  <p className="font-mono text-[10px] break-all text-muted-foreground/70">
                    {logFile}
                  </p>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
