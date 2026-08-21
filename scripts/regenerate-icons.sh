#!/usr/bin/env bash
# Rebuild the whole app icon set from the five source renders in
# tauri-src/icons/sources/.
#
# default.png is the app's real icon: it becomes icon.icns and every sized PNG,
# so Finder, Launchpad and Spotlight show it too — and so does the Dock once the
# process is gone. orange.png, green.png, purple.png and black.png ship as
# alternates in icons/alt/ and are only ever applied to the Dock of a running
# app — see tauri-src/src/app_icon.rs for why macOS allows nothing more than
# that.
#
# Adding or removing a source here means editing the ICONS manifest in
# app_icon.rs to match; its tests assert the exact set the picker offers.
#
# Needs python3 with Pillow. Run from anywhere.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=tauri-src/icons/sources
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The alternates, in the order the picker lists them. `default` is handled
# separately: it is the bundle icon, not an alternate.
ALTS=(orange green purple black)

# How much of the canvas the artwork occupies in the *inset* renders. Apple's
# macOS app-icon grid puts an 824px body on a 1024px canvas, so 824/1024.
#
# The renders in sources/ are full-bleed — they reach the canvas edge, with no
# margin at all. That is right for the bundle icon: the Dock feeds icon.icns
# through the system icon pipeline, which masks it and fits it to that same
# grid, so macOS supplies the margin. It is wrong for anything drawn by
# `NSApplication.setApplicationIconImage:`, which is a raw blit into the full
# Dock tile — no mask, no grid, no margin. Handing that path a full-bleed image
# renders it about 20% wider than every neighbour in the Dock, and, worse, wider
# than this app's own bundle icon, so switching to an alternate visibly resized
# the tile. Baking the margin in here is what makes the two paths agree.
ICON_GRID=${ICON_GRID:-0.8046875}

# Pad to a square canvas before resizing: the generator stretches a non-square
# input rather than letterboxing it, which visibly skews the click wheel. The
# current renders are already 1024x1024, so this is a no-op for them — it is
# here so a future non-square export doesn't silently ship distorted.
python3 - "$SRC" "$TMP" "$ICON_GRID" default "${ALTS[@]}" <<'PY'
import sys
from PIL import Image

src, out, grid, names = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4:]
for name in names:
    im = Image.open(f"{src}/{name}.png").convert("RGBA")
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    canvas.resize((1024, 1024), Image.LANCZOS).save(f"{out}/{name}_1024.png", optimize=True)

    # The inset render, for everything AppKit draws itself. 512 is plenty for
    # the Dock (256px at 2x) and keeps the base64 preview the picker fetches
    # over IPC small. Transparent margin, centred — the body lands on the same
    # grid the system icon pipeline would have fitted it to.
    body = round(512 * grid)
    inset = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    art = canvas.resize((body, body), Image.LANCZOS)
    off = (512 - body) // 2
    inset.paste(art, (off, off), art)
    inset.save(f"{out}/{name}_512_inset.png", optimize=True)
    print(f"{name}: {w}x{h} -> square {side} -> 1024 full-bleed + 512 inset ({body}px body)")
PY

npm run tauri -- icon "$TMP/default_1024.png"

# The generator emits iOS, Android and Windows sets unconditionally. This app is
# macOS only: 64x64.png is referenced by nothing in tauri.conf.json, and
# icon.ico / Square*Logo.png / StoreLogo.png are the Windows and Microsoft Store
# sizes. The macOS bundle takes only the four paths listed under `icon` in
# tauri.conf.json (32x32, 128x128, 128x128@2x, icon.icns) plus icon.png, which
# app_icon.rs compiles in as the picker's "Default" preview.
#
# Nothing here touches icons/icon.icon — the macOS 26 Icon Composer bundle,
# Apple's format for Liquid Glass icons. `tauri icon` does not emit it; `tauri
# build` does, from icon.png. Deleting it here would mean every build recreated
# a directory this script had just removed.
rm -rf tauri-src/icons/ios tauri-src/icons/android tauri-src/icons/64x64.png
rm -f tauri-src/icons/icon.ico tauri-src/icons/Square*Logo.png \
      tauri-src/icons/StoreLogo.png

# The alternate set is exactly what is in tauri-src/icons/alt/, and app_icon.rs
# pulls those in with include_bytes!. A file left over from an earlier layout
# would not be compiled in, only confusing — clear the directory rather than
# leave strays next to the ones that are live.
rm -f tauri-src/icons/alt/*.png
for name in "${ALTS[@]}"; do
  cp "$TMP/${name}_512_inset.png" "tauri-src/icons/alt/${name}.png"
done

# The picker's "Default" tile. It cannot just draw icon.png: that one stays
# full-bleed because `tauri build` derives the macOS 26 Icon Composer asset from
# it, and the system pipeline wants the body edge-to-edge. Drawing it next to
# three inset alternates would put the same mismatch inside the picker that this
# inset exists to remove from the Dock, so the preview gets its own copy.
cp "$TMP/default_512_inset.png" tauri-src/icons/icon-preview.png

echo
echo "done. bundle icon    <- sources/default.png (full-bleed)"
echo "     alternates     <- ${ALTS[*]} (icons/alt/, inset to $ICON_GRID)"
echo "     picker default <- icons/icon-preview.png (inset to $ICON_GRID)"
echo "rebuild with: npm run bundle"
