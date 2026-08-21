# Icon sources

The five renders every other icon in the repo is derived from. Everything in
`../` (`icon.icns`, `icon.png`, `icon-preview.png`, `32x32.png`, `128x128.png`,
`128x128@2x.png`) and everything in `../alt/` is generated — edit these five and
re-run `scripts/regenerate-icons.sh` from the repo root, never the outputs.

`tauri icon` also emits iOS, Android and Windows sets. This app is macOS only,
so the script deletes them; that list is the whole macOS set.

| file          | role                                                           |
| ------------- | -------------------------------------------------------------- |
| `default.png` | The app's real icon (blue). Becomes `icon.icns` and every sized PNG. |
| `orange.png`  | Alternate. Applied to the Dock at runtime only.                 |
| `green.png`   | Alternate. Applied to the Dock at runtime only.                 |
| `purple.png`  | Alternate. Applied to the Dock at runtime only.                 |
| `black.png`   | Alternate. Applied to the Dock at runtime only.                 |

`default.png` is the bundle icon, so it is what Finder, Launchpad and Spotlight
show, and what the Dock falls back to once the process exits. The picker's
first tile is `id: None` and AppKit restores the bundle icon when handed nil,
which is why "Default" needs no artwork of its own in `../alt/`.

The alternates only ever reach the running app's Dock tile: macOS has no
iOS-style alternate-icon API, and rewriting `Contents/Resources/icon.icns` to
change the rest would break the code signature. `../../src/app_icon.rs` has the
full reasoning.

## Adding an icon

1. Drop the render in here.
2. Add its name to `ALTS` in `scripts/regenerate-icons.sh` and re-run it.
3. Add one line to `ICONS` in `../../src/app_icon.rs`.

`app_icon::tests::the_picker_offers_the_five_shipped_icons` will fail until you
update it — that's deliberate, since a new entry appears in the picker with no
other code change.

Ids are persisted in `settings.json`, so renaming one silently resets anyone who
had it selected. (An id that no longer exists is not fatal: the setup hook logs
a warning, falls back to the bundle icon and clears the stored value.)

## `icon.icns` always shows up dirty

The icns encoder is not byte-reproducible: two runs over the same input produce
files of identical size that decode to identical pixels (verified — 0 differing
pixels of 1024×1024) but differ byte-for-byte. So `regenerate-icons.sh` dirties
`icon.icns` in git every time, with nothing visual behind it. Check out the old
file rather than committing the churn unless the art actually changed.

## Full-bleed sources, inset outputs

The renders in here reach the canvas edge with no margin, and two different
consumers want two different things from that:

- **The bundle icon** (`icon.icns`, and the macOS 26 Icon Composer asset
  `tauri build` derives from `icon.png`) wants it full-bleed. The Dock feeds
  that through the system icon pipeline, which masks the art and fits it to
  Apple's icon grid — an 824px body on a 1024px canvas. macOS supplies the
  margin, so shipping art that already had one would inset it twice.
- **Anything AppKit draws itself** — the `../alt/` set, applied with
  `setApplicationIconImage` — wants it inset. That call is a raw blit into the
  Dock tile: no mask, no grid, no margin. A full-bleed image there renders about
  20% wider than every neighbour, and wider than this app's own bundle icon, so
  picking an alternate visibly resized the tile.

`regenerate-icons.sh` therefore emits both, and the `ICON_GRID` variable at the
top of it is the 824/1024 fraction. `icon-preview.png` is the inset copy of the
default artwork; it exists only so the picker's "Default" tile matches the four
alternates beside it, and is never applied as an image.

## Known limitations

- The match is close, not exact. Measured against a neighbouring Dock tile at
  2x, an inset alternate comes out about 5% wide — down from about 20% before
  the inset existed, and no longer distinguishable from the bundle icon by eye.
  Tune `ICON_GRID` in `regenerate-icons.sh` if that ever stops being true; the
  bundle icon is not adjustable from here, since macOS fits it to the grid
  itself.
