//! Alternate app icons.
//!
//! macOS has no iOS-style alternate-icon API — `setAlternateIconName` does not
//! exist here, and Tauri exposes no app-icon setter either. The only mechanism
//! that does not invalidate the code signature is NSApplication's
//! `applicationIconImage`, which swaps the live Dock tile and the Cmd-Tab
//! entry. Finder, Launchpad and Spotlight keep showing the bundle's own icon:
//! changing those means rewriting `Contents/Resources/icon.icns`, which breaks
//! the seal `bundle-dylibs.sh` re-signs last and gets the app blocked by
//! Gatekeeper on the next launch.
//!
//! The swap is runtime-only and dies with the process, so `settings` stores the
//! choice and `lib::run`'s setup hook re-applies it at every launch. It also
//! means a quit app reverts to the bundle icon in the Dock's recents strip,
//! which is why the bundle ships the default (blue) artwork: that is the one on
//! screen whether or not the process is alive.

use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;
use serde::Serialize;
use tauri::AppHandle;

use base64::Engine;

/// The shipped set. Icons are compiled in rather than declared as bundle
/// resources: `include_bytes!` sidesteps resource paths resolving differently
/// under `tauri dev` and inside a packaged .app, and five 512x512 PNGs of
/// ~150 KB are noise next to the binary.
///
/// These carry a transparent margin the renders in `icons/sources/` do not:
/// `setApplicationIconImage` blits straight into the Dock tile, with none of
/// the masking and grid-fitting the system icon pipeline applies to the
/// bundle's own icns. Handed a full-bleed image it draws about 20% wider than
/// every neighbour — see `scripts/regenerate-icons.sh`, which bakes the margin
/// in.
///
/// Adding one is a file in `icons/alt/` plus a line here. Ids are persisted in
/// settings, so renaming one silently resets anyone who had it selected.
const ICONS: &[(&str, &str, &[u8])] = &[
    ("orange", "Orange", include_bytes!("../icons/alt/orange.png")),
    ("green", "Green", include_bytes!("../icons/alt/green.png")),
    ("purple", "Purple", include_bytes!("../icons/alt/purple.png")),
    ("black", "Black", include_bytes!("../icons/alt/black.png")),
];

/// The bundle's own icon — the blue artwork, so Finder, Launchpad and
/// Spotlight agree with what the picker calls "Default". Kept out of `ICONS`
/// because it is never applied as an image: AppKit restores it when handed
/// nil. The picker still needs something to draw on that tile, and serving it
/// from the same response is what lets the UI map straight over the list.
///
/// This is `icon-preview.png`, not the `icon.png` the bundle is built from:
/// that one has to stay full-bleed for the icns and Icon Composer asset, and
/// drawing it beside four inset alternates would make the picker tiles
/// disagree in size the way the Dock used to.
const DEFAULT_ICON: &[u8] = include_bytes!("../icons/icon-preview.png");

/// Label for the `None` entry. The other four are named for their colourway;
/// this one is the app's own identity rather than a colour, and it is the
/// tile Finder and the Dock fall back to, so it is named for that role.
const DEFAULT_LABEL: &str = "Default";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppIconInfo {
    /// None is the bundle's own icon.
    pub id: Option<String>,
    pub label: String,
    /// A `data:` URL rather than a path or an asset-protocol entry — the
    /// picker paints previews straight from the list response, and the CSP
    /// already allows `data:` in img-src for artwork.
    pub preview: String,
}

fn data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// The bundle icon first, then the alternates in manifest order.
pub fn list() -> Vec<AppIconInfo> {
    std::iter::once(AppIconInfo {
        id: None,
        label: DEFAULT_LABEL.to_string(),
        preview: data_url(DEFAULT_ICON),
    })
    .chain(ICONS.iter().map(|(id, label, bytes)| AppIconInfo {
        id: Some((*id).to_string()),
        label: (*label).to_string(),
        preview: data_url(bytes),
    }))
    .collect()
}

fn bytes_for(id: &str) -> Option<&'static [u8]> {
    ICONS
        .iter()
        .find(|(known, _, _)| *known == id)
        .map(|(_, _, bytes)| *bytes)
}

/// Applies an icon to the Dock. `None` restores the bundle's own icon, which
/// is exactly what AppKit does when handed a nil image — so "Default" needs no
/// special case beyond not resolving any bytes.
///
/// Fails on an unknown id so a caller can tell a stale stored preference from a
/// working one; the bytes are resolved before the main-thread hop for that
/// reason.
pub fn apply(app: &AppHandle, id: Option<&str>) -> Result<(), String> {
    let bytes = match id {
        None => None,
        Some(id) => Some(bytes_for(id).ok_or_else(|| format!("unknown app icon: {id}"))?),
    };

    // `setApplicationIconImage` is main-thread-only, and commands run on the
    // blocking pool.
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let ns_app = NSApplication::sharedApplication(mtm);
        let image = bytes.and_then(|bytes| {
            let data = NSData::with_bytes(bytes);
            NSImage::initWithData(NSImage::alloc(), &data)
        });
        // SAFETY: on the main thread (marker above), and `image` is either a
        // live NSImage we just decoded or nil.
        unsafe { ns_app.setApplicationIconImage(image.as_deref()) };
    })
    .map_err(|e| format!("couldn't set the Dock icon: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for (id, _, _) in ICONS {
            assert!(!id.is_empty(), "an icon has an empty id");
            assert!(seen.insert(*id), "duplicate icon id: {id}");
        }
    }

    #[test]
    fn every_icon_is_a_png() {
        // include_bytes! embeds whatever is at that path, truncated or in the
        // wrong format included. Without this the failure surfaces as a blank
        // Dock tile at runtime, with nothing pointing at the cause.
        let all = ICONS
            .iter()
            .map(|(id, _, bytes)| (*id, *bytes))
            .chain(std::iter::once(("<default>", DEFAULT_ICON)));
        for (id, bytes) in all {
            assert!(bytes.len() > 8, "{id} is empty or truncated");
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{id} is not a PNG");
        }
    }

    #[test]
    fn the_picker_offers_the_five_shipped_icons() {
        // The blue bundle icon plus four alternates. An icon added to ICONS
        // shows up in the picker with no other code change, so this is the
        // check that catches one arriving — or going missing because a source
        // was renamed without regenerate-icons.sh being re-run.
        //
        // Order matters as much as membership — the bundle icon leads, and it
        // is the artwork the Dock falls back to once the process exits.
        let labels: Vec<String> = list().into_iter().map(|i| i.label).collect();
        assert_eq!(labels, ["Default", "Orange", "Green", "Purple", "Black"]);
    }

    #[test]
    fn the_alternates_are_all_different_images() {
        // Every alternate is a separate include_bytes! of a file the icon
        // script writes. Two ids resolving to identical bytes means a copy
        // step aliased them, which the picker shows as two tiles that look the
        // same and swap to the same Dock icon.
        for (i, (id_a, _, a)) in ICONS.iter().enumerate() {
            for (id_b, _, b) in &ICONS[i + 1..] {
                assert_ne!(a, b, "{id_a} and {id_b} are the same image");
            }
            assert_ne!(
                *a, DEFAULT_ICON,
                "{id_a} is the same image as the bundle icon"
            );
        }
    }

    #[test]
    fn unknown_ids_do_not_resolve() {
        assert!(bytes_for("no-such-icon").is_none());
        assert!(bytes_for("").is_none());
    }

    #[test]
    fn list_leads_with_default_then_the_manifest() {
        let listed = list();
        assert_eq!(listed.len(), ICONS.len() + 1);

        // The picker renders the list in order and sends `id` straight back to
        // set_app_icon, so a Default that isn't first — or isn't null — puts
        // the wrong tile in the leading slot and makes "no alternate" unclickable.
        assert_eq!(listed[0].id, None);
        assert_eq!(listed[0].label, DEFAULT_LABEL);
        assert!(listed[1..].iter().all(|i| i.id.is_some()));

        for info in &listed {
            assert!(!info.label.is_empty(), "{:?} has no label", info.id);
            assert!(
                info.preview.starts_with("data:image/png;base64,"),
                "{:?} preview is not a data URL",
                info.id
            );
        }
    }
}
