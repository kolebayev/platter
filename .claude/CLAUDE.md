# Platter — working notes

Tauri 2 + React app that manages a click-wheel iPod Classic through libgpod via
a hand-written C bridge. macOS only.

## Build and run

- Neither half sits where its tool expects. The Rust/Tauri side is
  **`tauri-src/`**, not `src-tauri/`; the React side is **`ui/`**, not `src/`.
  The Tauri CLI finds its half by searching for `tauri.conf.json` rather than
  by directory name, and Vite finds the other through the `@/*` alias in
  `tsconfig.json` + `vite.config.ts` — so `npm run tauri …` and `npm run dev`
  work unchanged. Everything that spells a path does not: `--manifest-path`,
  the scripts, CI, `index.html`'s entry, `components.json`, the `build`
  symlink.
- Cargo is **not** on `PATH` here. Export it first:
  `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`
- **Always build releases with `npm run bundle`**, never bare `npm run tauri build`.
  The bare build produces an app that links `~/.local` and `/opt/homebrew` and
  runs on this machine only; `bundle-dylibs.sh` is what makes it self-contained.
- `bundle-dylibs.sh` is **not idempotent** and refuses to run twice. dylibbundler
  runs with `-od`, so a second pass empties `Contents/Frameworks` and then cannot
  refill it — the binaries by then point at `@executable_path` paths it can no
  longer resolve. Rebuild before bundling again.
- A bare `tauri build` after a bundle leaves a stale `_CodeSignature`, and the
  `.app` then fails to launch from Finder with LaunchServices error `-600`.
  Running `npm run bundle` fixes it, because bundling re-signs last.
- **The release build has no web inspector, and that is enforced.** Tauri links
  devtools into a release only when the `devtools` Cargo feature is on (debug
  gets it by default), so it is off here purely because `tauri` is declared with
  `features = []`. Adding the feature for one debugging session would otherwise
  ship a build whose UI opens with Cmd-Alt-I, so `bundle-dylibs.sh` greps the
  binary for wry's `-setInspectable:` and fails the release if it is there —
  the absence of the selector is the evidence, not the config. The capability
  also carries `core:webview:deny-internal-toggle-devtools`, which blocks the
  JS `toggleDevtools()` IPC path independently; it does not affect the native
  inspector in `npm run tauri dev`.
- Every shell script lives in `scripts/` and derives the repo root from its own
  location, so all of them run from anywhere.
- `tauri-src/binaries/` is gitignored. A fresh clone must run
  `./scripts/stage-ffmpeg.sh` before its first build or `externalBin` fails.
- Quit the app with `pkill -x platter-tauri`. AppleScript
  `tell application "platter-tauri"` silently fails — the bundle is named
  Platter, the process is platter-tauri.

## Invariants — break these and a user loses data

- **The FFI struct mirror.** `GpodTrackInfo`, `GpodTrackEdit` and `GpodImportSpec`
  are mirrored field-for-field by hand in `gpod.rs`. Change one side and you must
  change the other; `gpod::tests::repr_c_mirrors_match_the_header` compares sizes
  and offsets against the C bridge and is the only thing guarding this. Run
  `cargo test` after touching either side.
- **`art_gen`.** The artwork cache is keyed on raw `Itdb_Track` pointers, which
  are reused across library opens. The generation counter is what makes a cached
  entry safe; never insert without re-checking the generation captured at
  extraction time.
- **Play Counts is positional.** Entries in `iPod_Control/iTunes/Play Counts`
  match iTunesDB tracks by position, not by id. Any backup of one is only
  coherent with a backup of the other taken at the same instant — `backup_pair`
  in `library.rs` copies both together, at connect and then on a cadence, and
  always before a write. Never back up one without the other. `itdb_write`
  deletes the file, so plays the device wrote after we opened are lost unless
  they were backed up first.
- **libgpod is not thread-safe.** Every call goes through the single
  `Mutex<Library>`. Commands run inside the `blocking()` helper
  (`commands.rs`) so FFI and subprocesses never stall a tokio worker.
- Do not hold the library mutex across a slow operation (a USB copy, an ffmpeg
  run, a full DB write) — the whole UI blocks behind it. The import loop takes
  the lock **per file** for this reason, and re-resolves the db handle inside
  every iteration: a close or eject between files frees it, so a handle cached
  across an unlock is a use-after-free waiting to happen.

## Testing

- `npm test` — Vitest over the pure modules in `ui/lib`. Fast, no browser.
- `cargo test` — the ABI mirror test, the convert/cue parsing suite, and
  `tests/library_roundtrip.rs`, which drives the iTunesDB write path through the
  real FFI against a temp-dir iPod skeleton. That last one is the gate for any
  change to `library.rs` or the import loop: every assertion re-opens the
  database from disk, because checking the in-memory copy would pass even if
  `itdb_write` never wrote.
- Fixture iPod: `hdiutil attach ~/VirtualPods/PodSim.dmg` mounts `/Volumes/PODSIM`.
  Re-seed with `cargo run --example seed_podsim` (`--enrich`, `--covers`).
  The volume must be `UDRW`, must pre-create `iPod_Control/{Music/F00..F19,iTunes,Artwork}`
  (libgpod 0.8.3 does not), and needs a real `ModelNumStr` in
  `iPod_Control/Device/SysInfo` or artwork is silently not written.
- `commands.rs` and `tags.rs` still have **no tests**. That is the
  riskiest gap in the repo — it is the iTunesDB write path.

## Environment facts worth not rediscovering

- **Homebrew has no libgpod.** It is built from source and lives at `~/.local`
  (override with `LIBGPOD_PREFIX`). CI has to build it.
- ffmpeg/ffprobe **are** bundled as Tauri sidecars; `convert.rs` prefers the
  bundled pair over `PATH`. The ones staged on this machine are Homebrew's
  **GPLv3** build — fine locally, but they must not ship. See
  `.claude/docs/ffmpeg-build.md` (local-only) or release.yml for the LGPL
  configure line.
- The shell is zsh, so `shopt` is unavailable and an unmatched glob is an error
  rather than a literal.
- `otool -L` prints the file's own path as its first line. Filtering its output
  for build-machine paths without `tail -n +2` makes the check match itself.
- Every icon in `tauri-src/icons/` is **generated**. The five sources live in
  `tauri-src/icons/sources/` (`default.png` = the blue bundle icon, plus the
  `orange`/`green`/`purple`/`black` Dock alternates);
  `./scripts/regenerate-icons.sh` rebuilds the whole set. Adding or dropping
  one means editing `ALTS` in that script *and* the `ICONS` manifest in
  `app_icon.rs` — `app_icon::tests::the_picker_offers_the_five_shipped_icons`
  asserts the exact set.
  `npm run tauri -- icon` also emits `ios/` and `android/` unconditionally —
  the script deletes them, this app is macOS only. The icns encoder is not
  byte-reproducible, so `icon.icns` shows up modified after every run even when
  the pixels are identical.
- **Never edit `tauri-src/icons/icon_template.icon/` by hand.** It is an Icon
  Composer document (`icon.json` + `Assets/*.svg`) authored in the GUI, and
  nothing in the build reads it — hand edits to the JSON or the SVGs desync it
  from what Icon Composer writes back and get clobbered on the next save. It is
  the artwork master: change the icon there, export 1024x1024 full-bleed PNGs
  into `tauri-src/icons/sources/`, then run `./scripts/regenerate-icons.sh`.
  (Separately, `tauri build` derives its own Icon Composer asset from
  `icon.png`; the script deliberately leaves that alone.)
- The dylibs on **this machine** (libgpod at `~/.local`, Homebrew GLib chain,
  Homebrew ffmpeg) carry `LC_BUILD_VERSION minos 26.0` — built without
  `MACOSX_DEPLOYMENT_TARGET`. `bundle-dylibs.sh` fails a bundle whose Mach-Os
  require a newer macOS than tauri.conf.json's `minimumSystemVersion` (14.0);
  local bundles need `ALLOW_MINOS_MISMATCH=1` until the deps are rebuilt with
  the target pinned. The release workflow builds everything pinned.
- macOS has **no alternate-app-icon API**. `NSApplication`'s
  `applicationIconImage` swaps the Dock tile and nothing else; Finder,
  Launchpad and Spotlight follow `Contents/Resources/icon.icns`, and rewriting
  that in a built bundle breaks the signature `bundle-dylibs.sh` re-signs last.
  Tauri exposes no setter for it either, hence the direct objc2 call in
  `app_icon.rs`.
