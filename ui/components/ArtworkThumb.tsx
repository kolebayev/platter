import { useEffect, useState, useSyncExternalStore } from "react";
import { Music } from "lucide-react";
import {
  artworkFetchSize,
  cachedArtwork,
  getArtVersion,
  markArtworkUndecodable,
  releaseArtwork,
  resolvedArtwork,
  retainArtwork,
  subscribeArt,
} from "@/lib/api";
import { cn } from "@/lib/utils";

/** Album/track cover, fetched lazily from the backend as a data URL. Falls
 * back to the music-note placeholder, with the missing-art count badge the
 * Swift app showed when several tracks lack covers. */
export function ArtworkThumb({
  trackId,
  size,
  missingCount = 0,
  fill = false,
  className,
}: {
  trackId: string | null;
  size: number;
  missingCount?: number;
  /** Fluid mode: skip the fixed pixel box so a parent grid sizes the tile
   * (cover walls); className then carries w-full h-full. */
  fill?: boolean;
  className?: string;
}) {
  // Paint synchronously from the resolved cache when possible — with a
  // virtualized list rows remount constantly during scroll, and a one-frame
  // placeholder flash per remount reads as flicker.
  const fetchSize = artworkFetchSize(size);
  // Re-runs the effect when caches are invalidated (cover replaced) even
  // though trackId itself is unchanged.
  const artVersion = useSyncExternalStore(subscribeArt, getArtVersion);
  const [src, setSrc] = useState<string | null>(() =>
    trackId ? resolvedArtwork(trackId, fetchSize) ?? null : null,
  );

  useEffect(() => {
    if (!trackId) {
      setSrc(null);
      return;
    }
    const known = resolvedArtwork(trackId, fetchSize);
    if (known !== undefined) {
      setSrc(known);
      return;
    }
    let cancelled = false;
    setSrc(null);
    // Retain/release lets the fetch scheduler skip requests every subscriber
    // scrolled away from before they were dispatched.
    retainArtwork(trackId, fetchSize);
    cachedArtwork(trackId, fetchSize).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
      releaseArtwork(trackId, fetchSize);
    };
  }, [trackId, fetchSize, artVersion]);

  const box = fill ? undefined : { width: size, height: size };

  if (src) {
    return (
      <img
        src={src}
        style={box}
        className={cn(
          "shrink-0 rounded object-cover",
          fill && "h-full w-full",
          className,
        )}
        alt=""
        // A cover the webview cannot decode would otherwise paint WebKit's
        // broken-image icon — the macOS system question mark, which looks
        // like a foreign asset dropped into the UI. Fall back to our own
        // placeholder and tell the cache, so the other thumbs on this key
        // never paint it either.
        onError={() => {
          if (trackId) markArtworkUndecodable(trackId, fetchSize);
          setSrc(null);
        }}
      />
    );
  }
  return (
    <div
      style={box}
      className={cn(
        "flex shrink-0 flex-col items-center justify-center gap-0.5 rounded bg-muted text-muted-foreground",
        fill && "h-full w-full",
        className,
      )}
    >
      <Music style={{ width: size * 0.35, height: size * 0.35 }} />
      {missingCount > 1 && (
        <span className="font-medium" style={{ fontSize: size * 0.3 }}>
          {missingCount}
        </span>
      )}
    </div>
  );
}
