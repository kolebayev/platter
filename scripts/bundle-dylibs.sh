#!/usr/bin/env bash
# Makes the built .app self-contained: copies libgpod and its GLib dependency
# chain (from ~/.local and Homebrew) into Contents/Frameworks and rewrites the
# install names, so the app runs on Macs without those libraries. Then
# re-signs, repacks the DMG and packs the updater archive, since the ones tauri
# build produced contain the un-patched app.
#
# Run after `npm run tauri build`:
#   ./scripts/bundle-dylibs.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/tauri-src/target/release/bundle"
APP="${1:-$BUNDLE/macos/Platter.app}"
BIN="$APP/Contents/MacOS/platter-tauri"
FRAMEWORKS="$APP/Contents/Frameworks"

[ -x "$BIN" ] || { echo "error: $BIN not found — run 'npm run tauri build' first" >&2; exit 1; }

# Refuse to run twice against the same build. dylibbundler runs with -od
# ("overwrite output dir"): a second pass empties Contents/Frameworks and then
# cannot refill it, because the binaries now reference @executable_path paths it
# can no longer resolve back to the originals. What is left still passes an
# install-name check — nothing points at /opt/homebrew any more — while having
# no libraries at all. Fail loudly instead of shipping that.
if otool -L "$BIN" | tail -n +2 | grep -q '@executable_path/../Frameworks/'; then
  echo "error: $(basename "$APP") has already been bundled." >&2
  echo "       Re-running would wipe Contents/Frameworks. Rebuild first:" >&2
  echo "           npm run bundle" >&2
  exit 1
fi

echo "==> Bundling dylibs into $FRAMEWORKS"
# ONE invocation with three -x, never three invocations. -od means "overwrite
# the output directory": a second dylibbundler run against the same -d erases
# what the first produced, so splitting ffmpeg into its own call would silently
# delete libgpod and the GLib chain. The app would then fail at first iPod
# access rather than at build time.
#
# @executable_path resolves per spawned process, and all three binaries sit at
# Contents/MacOS — depth 1 — so the one prefix is correct for all of them.
FF_ARGS=()
for side in ffmpeg ffprobe; do
  if [ -x "$APP/Contents/MacOS/$side" ]; then
    FF_ARGS+=(-x "$APP/Contents/MacOS/$side")
  else
    echo "    note: $side sidecar not present — run ./scripts/stage-ffmpeg.sh to bundle it"
  fi
done

# Search paths honor the same env overrides the build does (build.rs reads
# LIBGPOD_PREFIX/BREW_PREFIX), so CI — which builds libgpod into the
# workspace — bundles from the prefix it actually linked against.
SEARCH=(-s "${LIBGPOD_PREFIX:-$HOME/.local}/lib" -s "${BREW_PREFIX:-$(brew --prefix)}/lib")
[ -n "${FFMPEG_PREFIX:-}" ] && SEARCH+=(-s "$FFMPEG_PREFIX/lib")

dylibbundler -od -b \
  -x "$BIN" \
  "${FF_ARGS[@]}" \
  -d "$FRAMEWORKS" \
  -p '@executable_path/../Frameworks/' \
  "${SEARCH[@]}" \
  > /dev/null

echo "==> Re-signing"
# After dylibbundler, never before: it ad-hoc re-signs each binary it rewrites,
# and anything rewritten after the app is signed breaks the CodeResources seal.
#
# SIGN_IDENTITY defaults to ad-hoc ("-"), which is fine for local use but
# shows every downloader Gatekeeper's "damaged" dialog. A release sets it to a
# Developer ID Application identity and notarizes the DMG afterwards:
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" npm run bundle
#   xcrun notarytool submit <dmg> --keychain-profile <profile> --wait
#   xcrun stapler staple <app>
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
if [ "$SIGN_IDENTITY" = "-" ]; then
  # No hardened runtime on ad-hoc builds: library validation would refuse the
  # team-less dylibs in Contents/Frameworks and the app would die in dyld.
  codesign --force --deep --sign - "$APP"
else
  # Notarization requires the hardened runtime.
  codesign --force --deep --options runtime --sign "$SIGN_IDENTITY" "$APP"
fi

echo "==> Verifying"
# A corrupted signature still executes until the tampered page faults in, so
# "ffmpeg -version worked" is not evidence the pipeline is sound.
codesign --verify --deep --strict "$APP"
# Every Mach-O we ship — the three executables AND the whole copied-in dylib
# chain — has to satisfy both halves. Checking only the executables, or only the
# install names, is how a bundle that cannot possibly run still gets a green
# tick: "no /opt/homebrew references" is equally true of an app whose
# Frameworks directory is empty.
BAD='/opt/homebrew|/usr/local/Cellar|/Users/'
fail=0

[ -d "$FRAMEWORKS" ] && [ -n "$(ls -A "$FRAMEWORKS" 2>/dev/null)" ] || {
  echo "error: $FRAMEWORKS is empty — dylibbundler copied nothing" >&2
  exit 1
}

while IFS= read -r macho; do
  case "$(file -b "$macho")" in *Mach-O*) ;; *) continue ;; esac
  name="$(basename "$macho")"
  # tail -n +2 drops otool's header line, which is the binary's OWN path. This
  # repo lives under /Users, so grepping the header made the check match itself
  # and fail every run no matter how clean the dependencies were.
  deps="$(otool -L "$macho" | tail -n +2 | awk '{print $1}')"

  if printf '%s\n' "$deps" | grep -qE "$BAD"; then
    echo "error: $name still references a build-machine path" >&2
    printf '%s\n' "$deps" | grep -E "$BAD" | sed 's/^/       /' >&2
    fail=1
  fi

  while IFS= read -r dep; do
    case "$dep" in
      @executable_path/../Frameworks/*)
        lib="${dep#@executable_path/../Frameworks/}"
        [ -e "$FRAMEWORKS/$lib" ] || {
          echo "error: $name needs $lib, which is not in Contents/Frameworks" >&2
          fail=1
        } ;;
    esac
  done <<< "$deps"
done < <(find "$APP/Contents/MacOS" "$FRAMEWORKS" -type f)

[ "$fail" -eq 0 ] || exit 1

echo "==> Checking the web inspector is off"
# Tauri compiles devtools into a release build only when the `devtools` Cargo
# feature is on; in debug it is on by default. That makes "the shipped app has
# no inspector" a property of the feature list rather than of anything written
# down, and adding `features = ["devtools"]` for one debugging session would
# ship a build whose UI can be opened with Cmd-Alt-I and read.
#
# wry marks the WKWebView inspectable with -setInspectable:, and that selector
# is only linked when the feature is on — so its absence from the binary is the
# evidence, not the config. Checked here because `npm run bundle` is the only
# supported way to cut a release.
if strings -a "$BIN" | grep -q "setInspectable"; then
  echo "error: $(basename "$BIN") links -setInspectable:, so the release ships a" >&2
  echo "       usable web inspector. Drop the \`devtools\` feature from tauri in" >&2
  echo "       tauri-src/Cargo.toml and rebuild." >&2
  exit 1
fi

echo "==> Checking deployment targets"
# Every bundled Mach-O must run on the OS tauri.conf.json promises. Homebrew
# bottles and a libgpod built without MACOSX_DEPLOYMENT_TARGET pin their minos
# to the build machine's OS — the app then launches nowhere older, with dyld's
# least helpful error. Rebuild the offending dependency with
# MACOSX_DEPLOYMENT_TARGET set (release.yml shows the ffmpeg build).
MIN_OS="$(python3 -c 'import json;print(json.load(open("'"$ROOT"'/tauri-src/tauri.conf.json"))["bundle"]["macOS"]["minimumSystemVersion"])')"
minos_fail=0
while IFS= read -r macho; do
  case "$(file -b "$macho")" in *Mach-O*) ;; *) continue ;; esac
  minos="$(otool -l "$macho" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit} /LC_VERSION_MIN_MACOSX/{g=1} g&&/version/{print $2; exit}')"
  [ -n "$minos" ] || continue
  if [ "$(printf '%s\n%s\n' "$MIN_OS" "$minos" | sort -V | tail -1)" != "$MIN_OS" ]; then
    echo "error: $(basename "$macho") requires macOS $minos, but the bundle claims $MIN_OS" >&2
    minos_fail=1
  fi
done < <(find "$APP/Contents/MacOS" "$FRAMEWORKS" -type f)
if [ "$minos_fail" -ne 0 ]; then
  if [ "${ALLOW_MINOS_MISMATCH:-0}" = "1" ]; then
    echo "warning: continuing despite deployment-target mismatches (ALLOW_MINOS_MISMATCH=1)" >&2
  else
    echo "       Rebuild those libraries with MACOSX_DEPLOYMENT_TARGET=$MIN_OS," >&2
    echo "       or set ALLOW_MINOS_MISMATCH=1 for a local-only build." >&2
    exit 1
  fi
fi

echo "==> Repacking DMG"
# Versioned name so release assets are distinguishable, arch-tagged because
# this build is Apple Silicon-only, staged beside an /Applications symlink so
# the DMG has a drag-to-install affordance instead of inviting users to run
# the app from a read-only image.
VERSION="$(python3 -c 'import json;print(json.load(open("'"$ROOT"'/tauri-src/tauri.conf.json"))["version"])')"
ARCH="$(uname -m)"
DMG="$BUNDLE/dmg/Platter_${VERSION}_${ARCH}.dmg"
mkdir -p "$BUNDLE/dmg"
rm -f "$DMG"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Platter -srcfolder "$STAGE" -ov -format UDZO "$DMG" > /dev/null

echo "==> Packing the updater archive"
# tauri-plugin-updater downloads a tarball of the .app, not the DMG, and
# verifies it against the minisign public key in tauri.conf.json. The archive
# is built HERE rather than by tauri's own `createUpdaterArtifacts`, which runs
# inside `tauri build` — before this script has copied a single dylib. That
# archive would carry the app that still links ~/.local and /opt/homebrew: it
# installs cleanly, then dies in dyld on the user's machine, and the user has
# no un-update. Same reason the DMG is repacked above.
#
# Signing is skipped when no key is present, so a local `npm run bundle` stays
# a one-command build. A release passes TAURI_SIGNING_PRIVATE_KEY.
TARBALL="$BUNDLE/macos/Platter.app.tar.gz"
rm -f "$TARBALL" "$TARBALL.sig"
tar czf "$TARBALL" -C "$(dirname "$APP")" "$(basename "$APP")"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  # Explicitly empty rather than unset: with no password variable at all the
  # CLI prompts on a TTY and blocks forever on a runner.
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  (cd "$ROOT" && npm run --silent tauri -- signer sign "$TARBALL" > /dev/null)
  [ -f "$TARBALL.sig" ] || { echo "error: signer produced no $TARBALL.sig" >&2; exit 1; }
else
  echo "    note: TAURI_SIGNING_PRIVATE_KEY unset — archive built but not signed."
  echo "          An unsigned archive is inert; the updater refuses it."
fi

echo "==> Done"
echo "    app: $APP"
echo "    dmg: $DMG"
echo "    updater: $TARBALL$([ -f "$TARBALL.sig" ] && echo " (+ .sig)")"
if [ "$SIGN_IDENTITY" = "-" ]; then
  echo "    NOTE: ad-hoc signed. Downloaders will see Gatekeeper's 'damaged' dialog;"
  echo "          they must run: xattr -dr com.apple.quarantine /Applications/Platter.app"
  echo "          Ship releases with SIGN_IDENTITY set and notarize (see comments above)."
fi
