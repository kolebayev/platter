import { useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, Music2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImportOutcome, PendingImport } from "@/lib/types";

export function ImportDialog({
  open,
  onOpenChange,
  onReadTags,
  onImport,
  onBrowseDrive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Closes this dialog and opens the drive picker. */
  onBrowseDrive: () => void;
  /** Routed through App's run() so per-file progress shows and errors alert;
   * resolves null on failure. */
  onReadTags: (paths: string[]) => Promise<PendingImport[] | null>;
  /** Resolves with the outcome; failedIndices index into the submitted items. */
  onImport: (items: PendingImport[]) => Promise<ImportOutcome>;
}) {
  const [pending, setPending] = useState<PendingImport[]>([]);
  // File paths whose embedded cover the webview could not decode. Purely a
  // display concern — the bytes still go to the backend on import, which
  // decodes them with gdk-pixbuf, not WebKit — but without this an
  // undecodable cover paints WebKit's broken-image icon, the macOS system
  // question mark, instead of the placeholder beside every other row.
  const [undecodableArt, setUndecodableArt] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // Bumped on close: a tag read still in flight when the user cancels must
  // not repopulate the (closed) dialog for its next opening.
  const generationRef = useRef(0);

  function close(next: boolean) {
    if (!next) {
      generationRef.current++;
      setPending([]);
      setUndecodableArt(new Set());
    }
    onOpenChange(next);
  }

  async function chooseFiles() {
    const files = await openDialog({
      multiple: true,
      filters: [
        {
          name: "Audio",
          // Beyond MP3/M4A/AAC (imported as-is), lossless formats convert to
          // iPod-spec Apple Lossless via ffmpeg on the way in.
          extensions: [
            "mp3", "m4a", "aac",
            "flac", "alac", "wav", "wave", "aif", "aiff", "aifc",
            "ape", "wv", "tta", "dsf", "dff", "shn", "caf", "w64", "rf64",
          ],
        },
      ],
    });
    if (!files || files.length === 0) return;
    const generation = generationRef.current;
    setLoading(true);
    try {
      const staged = await onReadTags(files as string[]);
      if (staged && generationRef.current === generation) {
        setPending((prev) => [...prev, ...staged]);
      }
    } finally {
      setLoading(false);
    }
  }

  function update(index: number, patch: Partial<PendingImport>) {
    setPending((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  async function runImport() {
    setImporting(true);
    try {
      const outcome = await onImport(pending);
      if (outcome.ok) {
        close(false);
      } else if (outcome.failedIndices.length > 0) {
        // Keep exactly the failed rows staged (edits intact) so a retry
        // doesn't re-import the tracks that already made it on.
        const items = pending;
        setPending(outcome.failedIndices.map((i) => items[i]).filter(Boolean));
      }
      // Whole-call failure (outcome.failedIndices empty): keep everything
      // staged next to the error alert.
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <div className="flex items-center justify-between pr-6">
            <DialogTitle>Add Songs</DialogTitle>
            <div className="flex items-center gap-2">
              {/* Handing off to App rather than opening a dialog from inside
                  this one: nesting two Dialogs fights over focus and the
                  Escape key. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={onBrowseDrive}
                disabled={loading}
              >
                From Drive…
              </Button>
              <Button variant="outline" size="sm" onClick={chooseFiles} disabled={loading}>
                Choose Files…
              </Button>
            </div>
          </div>
        </DialogHeader>

        {pending.length === 0 ? (
          <div className="flex min-h-60 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <Music2 className="size-10" />
            <p className="text-sm font-medium">No Files Chosen</p>
            <p className="max-w-sm text-xs">
              Pick MP3, M4A/AAC or lossless files (FLAC, WAV, AIFF, DSD…) —
              lossless audio converts to iPod-ready Apple Lossless on import.
              Tags and embedded cover art are read automatically; you can edit
              anything below before importing.
            </p>
          </div>
        ) : (
          <div className="-mx-1 flex-1 space-y-3 overflow-y-auto px-1 py-1">
            {pending.map((item, i) => (
              <div key={`${item.filePath}-${i}`} className="flex items-start gap-3">
                {item.artworkDataUrl && !undecodableArt.has(item.filePath) ? (
                  <img
                    src={item.artworkDataUrl}
                    className="size-11 shrink-0 rounded object-cover"
                    alt=""
                    onError={() =>
                      setUndecodableArt((s) => new Set(s).add(item.filePath))
                    }
                  />
                ) : (
                  <div className="flex size-11 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    <Music2 className="size-4" />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
                  <Input
                    placeholder="Title"
                    value={item.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                  />
                  <div className="flex gap-1.5">
                    <Input
                      placeholder="Artist"
                      value={item.artist}
                      onChange={(e) => update(i, { artist: e.target.value })}
                    />
                    <Input
                      placeholder="Album"
                      value={item.album}
                      onChange={(e) => update(i, { album: e.target.value })}
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      placeholder="Genre"
                      value={item.genre}
                      onChange={(e) => update(i, { genre: e.target.value })}
                    />
                    <Input
                      className="w-20 shrink-0"
                      placeholder="Year"
                      type="number"
                      value={item.year || ""}
                      onChange={(e) => update(i, { year: Number(e.target.value) || 0 })}
                    />
                    <Input
                      className="w-14 shrink-0"
                      placeholder="#"
                      type="number"
                      value={item.trackNumber || ""}
                      onChange={(e) =>
                        update(i, { trackNumber: Number(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading tags…
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            disabled={loading || importing}
            onClick={() => (pending.length === 0 ? chooseFiles() : runImport())}
          >
            {pending.length === 0
              ? "Add Songs"
              : `Import ${pending.length} Song${pending.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
