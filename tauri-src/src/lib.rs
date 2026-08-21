mod app_icon;
mod commands;
pub mod convert;
pub mod convert_job;
pub mod fsinfo;
pub mod gpod;
pub mod logging;
#[cfg(target_os = "macos")]
mod picker;
// Public so tests/ can drive the iTunesDB write path through the real FFI.
// Nothing outside this crate consumes it at runtime.
pub mod library;
mod settings;
mod tags;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // With panic = "abort" and stripped release binaries, a crash on a user's
    // machine otherwise leaves nothing to report a bug with. The hook writes
    // the panic (and its location) through the log file before the abort.
    std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}");
        eprintln!("panic: {info}");
    }));

    // Before the plugin below opens its file: last session's log is moved
    // aside so this one starts empty. The identifier comes off the generated
    // context rather than an AppHandle, which does not exist yet.
    let context = tauri::generate_context!();
    if let Some(dir) = logging::log_dir(&context.config().identifier) {
        logging::rotate(&dir);
    }

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    // ~/Library/Logs/<bundle-id>/platter.log — the file a bug
                    // report can actually attach.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("platter".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stderr),
                ])
                .level(log::LevelFilter::Info)
                // The updater logs a failed check at ERROR, and a failed check
                // is a routine state: the endpoint 404s for every build older
                // than the first release that carried a latest.json, and any
                // launch without a network does the same. Left on, this file —
                // the one a bug report attaches — opens with an error that
                // means nothing is wrong. `updates.ts` logs the same failure at
                // INFO with the same message, so nothing is lost.
                .level_for("tauri_plugin_updater", log::LevelFilter::Off)
                .max_file_size(2 * 1024 * 1024)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // The check itself is driven from the frontend, but the HTTP request
        // is made here — the webview's CSP allows no origin but its own, and
        // widening `connect-src` to reach GitHub would open that door for
        // every other thing the UI loads too.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(library::new_shared())
        .manage(convert_job::new_queue())
        .setup(|app| {
            // First lines of the session, and the earliest point they can be
            // written — the plugin's logger is installed as the plugin starts.
            for line in logging::session_header(
                app.package_info().version.to_string().as_str(),
                &logging::macos_version(),
                std::env::consts::ARCH,
            ) {
                log::info!("{line}");
            }

            // Covers staged by a previous run: a crash or a force-quit leaves
            // them behind, and nothing else ever removes them. Safe here and
            // only here — no import can be in flight before setup returns.
            tags::sweep_artwork_cache();

            // Background saves report through a Tauri event: a failed
            // auto-flush is unsaved edits the user believes are on the
            // device, and the flush thread has no other voice.
            {
                let handle = app.handle().clone();
                let lib = app.state::<library::SharedLibrary>();
                lib.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .set_error_notifier(std::sync::Arc::new(move |msg: &str| {
                        log::error!("library flush failed: {msg}");
                        let _ = handle.emit("library:flush-failed", msg.to_string());
                    }));
            }

            // Re-apply the stored Dock icon here rather than from the
            // frontend: the swap is runtime-only, and waiting for the webview
            // to boot would flash the default icon on every single launch.
            if let Some(id) = settings::load(app.handle()).app_icon {
                if let Err(e) = app_icon::apply(app.handle(), Some(&id)) {
                    // A stored id that this build no longer ships must not be
                    // fatal — fall back to the bundle icon and forget it, so
                    // the failure doesn't repeat at every launch.
                    log::warn!("app icon: {e}");
                    let mut stored = settings::load(app.handle());
                    stored.app_icon = None;
                    let _ = settings::save(app.handle(), &stored);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Normal quit: flush any dirty state before the process exits.
            // (Force-quit can't be caught; the 1.5s auto-flush covers that gap
            // for all but the most recent edit.)
            //
            // The flush runs on a worker and the close is deferred until it
            // finishes. Doing it inline blocks the main thread for a full
            // iTunesDB write — and if an import holds the library mutex, for
            // the rest of that import — which reads as a hung window.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Held for every request, including an impatient second click
                // while the first flush is still running. Letting that one
                // through would tear the process down mid-itdb_write, which is
                // the one way to actually corrupt the library.
                api.prevent_close();
                static FLUSHING: std::sync::atomic::AtomicBool =
                    std::sync::atomic::AtomicBool::new(false);
                if FLUSHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let handle = window.app_handle().clone();
                let window = window.clone();
                std::thread::spawn(move || {
                    {
                        let lib = handle.state::<library::SharedLibrary>();
                        // Poison must not turn a quit into a panic: the edits
                        // are still worth writing.
                        let mut lib = lib.lock().unwrap_or_else(|e| e.into_inner());
                        if let Err(msg) = lib.flush_if_dirty() {
                            // The window is going away, so a toast can't be
                            // seen — the log file is what's left to explain a
                            // missing edit.
                            log::error!("flush on close failed: {msg}");
                        }
                    }
                    let _ = window.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_volumes,
            commands::scan_volume,
            commands::open_library,
            commands::close_library,
            commands::eject_ipod,
            commands::open_privacy_settings,
            commands::request_volume_access,
            commands::list_app_icons,
            commands::get_app_icon,
            commands::set_app_icon,
            commands::read_tags,
            commands::set_fields,
            commands::import_tracks,
            commands::import_files,
            commands::update_track,
            commands::set_field,
            commands::set_artwork,
            commands::remove_tracks,
            commands::get_artwork,
            commands::convert_formats,
            commands::pick_music,
            commands::convert_add,
            commands::convert_remove,
            commands::convert_clear,
            commands::convert_estimate,
            commands::convert_start,
            commands::cancel_convert,
            logging::ui_log,
            logging::log_path,
            logging::export_logs,
        ])
        .run(context)
        .expect("error while running tauri application");
}
