import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArtworkThumb } from "@/components/ArtworkThumb";
import { GenreField } from "@/components/GenreField";
import type { BulkField } from "@/lib/api";
import type { Track } from "@/lib/types";

/** Albums repeat across artists ("Greatest Hits"), so an album is only the
 * same album when its artist matches too — album artist where set, since
 * that is what the iPod itself groups by. */
function albumKey(track: Track): string {
  return `${track.albumArtist || track.artist}\u0001${track.album}`;
}

/** The one value they all carry, or null when they disagree or are blank. */
function shared(values: string[]): string | null {
  const unique = new Set(values);
  if (unique.size !== 1) return null;
  const only = [...unique][0];
  return only || null;
}

/** "Oasis", "Oasis & 1 other", "4 values" — enough to confirm the selection
 * is what you meant without listing 40 names. */
function summarize(values: string[]): string {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length === 0) return "none";
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique.sort()[0]} & 1 other`;
  return `${unique.length} values`;
}

/** Last path component — the picked cover is confirmed by its file name,
 * since a local file can't be previewed without the asset protocol. */
function basename(path: string): string {
  return path.split("/").pop() || path;
}

/** Label per field, in the order the panel renders them. */
const FIELD_LABELS: Record<BulkField, string> = {
  artist: "Artist",
  albumArtist: "Album Artist",
  album: "Album",
  composer: "Composer",
  genre: "Genre",
};

/** Shown when more than one track is selected. Drafts prefill only when the
 * selection already agrees; one Apply at the end stamps JUST what the user
 * touched — fields and cover art alike — never an untouched field across a
 * mixed selection. */
export function BulkEditPanel({
  tracks,
  busy,
  onSetFields,
  onSetArtwork,
  onRemove,
}: {
  tracks: Track[];
  busy: boolean;
  /** Every changed field lands in ONE backend call — one lock take, one
   * IPC round-trip, one patch — instead of a call per field. */
  onSetFields: (fields: [BulkField, string][]) => Promise<unknown> | void;
  onSetArtwork: (imagePath: string) => Promise<unknown> | void;
  onRemove: () => void;
}) {
  const [initial] = useState<Record<BulkField, string>>({
    artist: shared(tracks.map((t) => t.artist)) ?? "",
    albumArtist: shared(tracks.map((t) => t.albumArtist)) ?? "",
    album: shared(tracks.map((t) => t.album)) ?? "",
    composer: shared(tracks.map((t) => t.composer)) ?? "",
    genre: shared(tracks.map((t) => t.genre)) ?? "",
  });
  const [draft, setDraft] = useState(initial);
  // A picked cover is a draft like any other field: it waits for Apply, so
  // one confirmation covers the whole edit and a mis-click costs nothing.
  const [pendingArt, setPendingArt] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // A field applies when it was changed away from its starting value — a
  // draft kept at "" can't stamp (matches the old per-field `disabled={!x}`).
  const changed = (Object.keys(initial) as BulkField[]).filter(
    (k) => draft[k] !== initial[k] && draft[k] !== "",
  );

  // What Apply will stamp, in button-label order.
  const pending = [
    ...changed.map((k) => FIELD_LABELS[k]),
    ...(pendingArt ? ["Cover Art"] : []),
  ];

  async function apply() {
    if (pending.length === 0 || busy || applying) return;
    setApplying(true);
    if (changed.length > 0) {
      await onSetFields(changed.map((field) => [field, draft[field]]));
    }
    // Artwork is its own backend call — the fields patch and the artwork
    // patch are separate, so they land one after the other, not together.
    if (pendingArt) {
      await onSetArtwork(pendingArt);
      setPendingArt(null);
    }
    setApplying(false);
  }

  // Memoized on the selection: these are full passes over it, and this panel
  // re-renders on every keystroke in its inputs — with a select-all-scale
  // selection the recounts were input latency, paid exactly while typing.
  const artworkCount = useMemo(
    () => tracks.filter((t) => t.hasArtwork).length,
    [tracks],
  );

  // A cover is only shown when the whole selection is one album. Painting the
  // first track's art across a mixed selection would imply it belongs to all
  // of them — and the button beside it replaces art on every selected track,
  // so that would be an actively misleading preview.
  const artTrackId = useMemo(() => {
    const sameAlbum = tracks.every((t) => albumKey(t) === albumKey(tracks[0]));
    return sameAlbum ? tracks.find((t) => t.hasArtwork)?.id ?? null : null;
  }, [tracks]);

  const summary = useMemo(
    () =>
      `${summarize(tracks.map((t) => t.artist))} · ${summarize(tracks.map((t) => t.album))}`,
    [tracks],
  );

  async function pickArtwork() {
    const file = await openDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof file === "string") setPendingArt(file);
  }

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        <div>
          <h2 className="text-lg font-semibold">{tracks.length} Tracks Selected</h2>
          <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
        </div>

        <Field label="Artist" mixed={initial.artist === ""}>
          <Input
            placeholder="Artist"
            value={draft.artist}
            onChange={(e) => setDraft((d) => ({ ...d, artist: e.target.value }))}
            title="Applies to every selected track, whether or not they agree today"
          />
        </Field>
        <Field label="Album Artist" mixed={initial.albumArtist === ""}>
          <Input
            placeholder="Album Artist"
            value={draft.albumArtist}
            onChange={(e) => setDraft((d) => ({ ...d, albumArtist: e.target.value }))}
            title="Sets what the iPod groups these albums under — the fix for a compilation split across 15 artists"
          />
        </Field>
        <Field label="Album" mixed={initial.album === ""}>
          <Input
            placeholder="Album"
            value={draft.album}
            onChange={(e) => setDraft((d) => ({ ...d, album: e.target.value }))}
            title="Applies to every selected track, whether or not they agree today"
          />
        </Field>
        <Field label="Composer" mixed={initial.composer === ""}>
          <Input
            placeholder="Composer"
            value={draft.composer}
            onChange={(e) => setDraft((d) => ({ ...d, composer: e.target.value }))}
            title="Applies to every selected track, whether or not they agree today"
          />
        </Field>
        <Field label="Genre" mixed={initial.genre === ""}>
          <GenreField
            value={draft.genre}
            onChange={(g) => setDraft((d) => ({ ...d, genre: g }))}
            allowEmpty
          />
        </Field>

        <div className="flex items-center gap-4">
          <ArtworkThumb
            trackId={artTrackId}
            size={80}
            missingCount={tracks.length - artworkCount}
            className="rounded-md"
          />
          <div className="flex min-w-0 flex-col items-start gap-1">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={busy}
                onClick={pickArtwork}
              >
                {pendingArt ? "Choose Another…" : "Choose Cover Art…"}
              </Button>
              {pendingArt && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy || applying}
                  onClick={() => setPendingArt(null)}
                >
                  Clear
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {pendingArt ? (
                <>
                  <span className="font-medium text-foreground">
                    {basename(pendingArt)}
                  </span>{" "}
                  is staged for all {tracks.length} tracks — applies when you
                  press Apply.
                </>
              ) : (
                <>
                  {artworkCount === 0
                    ? "None of these tracks have cover art — this sets it."
                    : artworkCount === tracks.length
                      ? "All tracks already have cover art — this replaces it."
                      : `${artworkCount} of ${tracks.length} already have cover art — this replaces it.`}{" "}
                  Applies with the rest of your changes.
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center border-t px-5 py-3">
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <Button variant="destructive" size="sm" type="button" disabled={busy}>
                Remove {tracks.length} Tracks
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove {tracks.length} tracks from the iPod?
              </AlertDialogTitle>
              <AlertDialogDescription>
                The files are deleted from the device the next time you save.
                This can't be undone from within Platter.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={onRemove}
              >
                Remove {tracks.length} Tracks
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="flex-1" />
        <Button type="submit" size="sm" disabled={pending.length === 0 || busy || applying}>
          {applying
            ? "Applying…"
            : pending.length > 0
              ? `Apply ${pending.length === 1 ? pending[0] : `${pending.length} Changes`} to ${tracks.length} Tracks`
              : "No Changes"}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  mixed,
  children,
}: {
  label: string;
  /** Selection disagrees on this value — flag it instead of hiding it. */
  mixed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="flex items-baseline gap-1.5 text-xs font-normal text-muted-foreground">
        {label}
        {mixed && <span className="text-muted-foreground/70">· mixed</span>}
      </Label>
      {children}
    </div>
  );
}
