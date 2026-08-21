//! Owns the open Itdb_iTunesDB handle. libgpod is not thread-safe, so every
//! touch of the handle happens while holding the one `Mutex<Library>` — the
//! same serialization the Swift app got from its dedicated DispatchQueue.

use crate::gpod::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// The Itdb_Track pointer, stringified. Stable for the lifetime of the
    /// open DB (libgpod never relocates tracks), and JSON strings dodge the
    /// 2^53 precision cliff a JS number would risk.
    pub id: String,
    pub title: String,
    pub artist: String,
    /// Empty when unset — which is meaningful: the Classic groups albums by
    /// this field and only falls back to `artist` when it's absent.
    pub album_artist: String,
    pub album: String,
    pub composer: String,
    pub genre: String,
    pub file_type: String,
    pub track_number: i32,
    /// Tracks on this disc, 0 when unset — the "of 12" in "3 of 12".
    pub track_count: i32,
    pub disc_number: i32,
    pub disc_count: i32,
    pub year: i32,
    pub bitrate: i32,
    /// Hz; 0 when the DB never recorded one.
    pub sample_rate: i32,
    pub duration_ms: i32,
    pub size_bytes: i64,
    /// Unix epoch seconds; None when the device never recorded one.
    pub date_added: Option<i64>,
    pub has_artwork: bool,
    /// Lifetime plays as of this open. libgpod merges the device's "Play
    /// Counts" file during itdb_parse, so fresh plays are already included —
    /// but only in memory until the next save writes them into the iTunesDB.
    /// `rating` and `last_played` arrive by the same route.
    pub play_count: i32,
    /// 0-100, 20 per star. 0 = unrated.
    pub rating: i32,
    /// Unix epoch seconds of the LAST play; None when never played. The
    /// device keeps no history beyond this one timestamp.
    pub last_played: Option<i64>,
    /// The DB's own colon-separated device path, e.g.
    /// ":iPod_Control:Music:F04:ABCD.mp3". Empty when the DB has none.
    pub ipod_path: String,
    /// False means the DB has a record with no audio file behind it.
    pub transferred: bool,
    pub has_drm: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub free_bytes: i64,
    pub total_bytes: i64,
}

/// Everything the frontend needs after any mutation — mirrors the Swift app's
/// reloadTracks + refreshCapacity pair firing after every operation.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub mount_point: Option<String>,
    pub tracks: Vec<Track>,
    pub capacity: Option<Capacity>,
}

/// What an edit actually changed. Mutations used to answer with a full
/// LibrarySnapshot — a rebuild, re-sort and re-serialization of every track
/// in the library per edit, which at tens of thousands of tracks is megabytes
/// of JSON across the IPC boundary for a one-field change. The frontend keeps
/// its own track array and folds this in instead; open/import still send the
/// full snapshot, because there the whole list genuinely changed.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPatch {
    /// Post-edit state of every surviving track the operation touched.
    pub updated: Vec<Track>,
    /// Ids that no longer resolve — removed, or gone under us.
    pub removed_ids: Vec<String>,
    /// Refreshed after every mutation: artwork and removals move real bytes.
    pub capacity: Option<Capacity>,
}

pub struct Library {
    db: Option<GpodDbRef>,
    mount_point: Option<String>,
    /// Track refs as of the last reload. Commands resolve incoming ids
    /// against this so a stale id from the frontend can't be dereferenced.
    live_refs: HashSet<usize>,
    /// Finished artwork data URLs keyed by (track ptr, size). Extraction is a
    /// pixbuf decode + PNG encode per call in the C bridge, so hits matter.
    /// Entries are evicted when a track's art changes or the track is removed
    /// (pointer values can be reused by a later import), and the whole map is
    /// dropped on open/close.
    art_cache: HashMap<(usize, i32), Arc<str>>,
    /// Recency order of art_cache keys, oldest first — hits re-queue their
    /// key at the back, eviction pops the front until under the byte budget.
    art_order: std::collections::VecDeque<(usize, i32)>,
    /// Sum of cached data-URL lengths; what the budget is enforced against.
    art_cache_bytes: usize,
    /// Bumped whenever cached art could be stale (open/close/evict). An
    /// extraction that started before the bump must not be inserted after it
    /// — art_cache_put checks the generation captured at extraction time.
    art_gen: u64,
    /// True when in-memory changes haven't been flushed to the device yet.
    dirty: bool,
    /// When the last mutation happened — the auto-flush thread waits for a
    /// short idle window so rapid edits coalesce into one iTunesDB write.
    last_dirty_at: Option<std::time::Instant>,
    /// When the on-device backup pair was last refreshed, and how many saves
    /// have gone by since. Both drive the refresh cadence in `save`.
    last_backup_at: Option<std::time::Instant>,
    saves_since_backup: u32,
    /// Wakes the auto-flush thread. Held here rather than in a global so a
    /// Library built for a test simply has nothing listening on it.
    flush_signal: Arc<(Mutex<bool>, std::sync::Condvar)>,
    /// Reports background save failures to the UI (a Tauri event, in the
    /// app). None in tests; the failure then only reaches the return value.
    /// A background flush that fails silently is unsaved edits the user
    /// believes are on the device.
    notify_error: Option<ErrorNotifier>,
    /// Device paths, in the database's own colon form, of tracks removed
    /// since the last successful write. `itdb_track_free` drops the record
    /// and nothing else, so without this the audio stayed on the device for
    /// good — a 74 GB iPod had 2 GB of it. The files go **after** the write
    /// succeeds, never before: deleting first and then failing to write
    /// leaves the on-disk database pointing at audio that no longer exists,
    /// which is a worse failure than the leak it replaces.
    pending_deletes: Vec<String>,
}

/// The channel background failures are reported through.
pub type ErrorNotifier = Arc<dyn Fn(&str) + Send + Sync>;

/// Thumbnails kept in memory, bounded by bytes rather than entries: `size` is
/// caller-chosen, so one entry can be a 15 KB 80px thumb or a 500 KB share-
/// card cover — an entry cap admitted hundreds of MB over a long session.
/// Eviction is LRU (hits re-queue), because scrolling back and forth through
/// an album wall re-touches the same keys and FIFO evicted exactly the
/// entries about to be re-requested.
const ART_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;

// Raw pointers strip Send; sound here because the pointer is only ever used
// while holding the Mutex that owns this struct.
unsafe impl Send for Library {}

pub type SharedLibrary = Arc<Mutex<Library>>;

/// A closed library with no auto-flush thread behind it. The app always wants
/// `new_shared`; tests want writes to happen only where they ask for them.
pub fn new_unmanaged() -> Library {
    Library {
        db: None,
        mount_point: None,
        live_refs: HashSet::new(),
        art_cache: HashMap::new(),
        art_order: std::collections::VecDeque::new(),
        art_cache_bytes: 0,
        art_gen: 0,
        dirty: false,
        last_dirty_at: None,
        last_backup_at: None,
        saves_since_backup: 0,
        flush_signal: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
        notify_error: None,
        pending_deletes: Vec::new(),
    }
}

pub fn new_shared() -> SharedLibrary {
    let lib = Arc::new(Mutex::new(new_unmanaged()));
    spawn_auto_flush(lib.clone());
    lib
}

/// How long the library must sit untouched before an edit is written out.
/// Coalesces rapid edits (bulk tag writes, a flurry of metadata tweaks) into a
/// single iTunesDB write, cutting flash wear and UI stalls.
const FLUSH_IDLE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Waits for `mark_dirty` to signal, lets the edits settle, then flushes.
///
/// It blocks on a condvar rather than polling: the previous version woke twice
/// a second for the life of the process — taking the library lock each time —
/// even with no iPod connected. Now an idle app costs nothing, and the thread
/// never competes with an import for the mutex.
fn spawn_auto_flush(lib: SharedLibrary) {
    let signal = lib.lock().unwrap().flush_signal.clone();
    std::thread::spawn(move || loop {
        {
            let (pending, cv) = &*signal;
            let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
            while !*pending {
                pending = cv.wait(pending).unwrap_or_else(|e| e.into_inner());
            }
            *pending = false;
        }

        // Sleep out the idle window, re-reading it each time: an edit landing
        // mid-wait pushes the deadline back, which is what does the coalescing.
        loop {
            let remaining = {
                let lib = lib.lock().unwrap_or_else(|e| e.into_inner());
                lib.last_dirty_at
                    .and_then(|t| FLUSH_IDLE.checked_sub(t.elapsed()))
            };
            match remaining {
                Some(wait) => std::thread::sleep(wait),
                None => break,
            }
        }

        // The lock is released before the notifier runs: emitting a Tauri
        // event re-enters arbitrary runtime code, and nothing that isn't
        // library state belongs under the library mutex.
        let (result, notify) = {
            let mut lib = lib.lock().unwrap_or_else(|e| e.into_inner());
            (lib.flush_if_dirty(), lib.notify_error.clone())
        };
        if let Err(msg) = result {
            eprintln!("auto-flush failed: {msg}");
            if let Some(notify) = notify {
                notify(&msg);
            }
        }
    });
}

impl Library {
    pub fn mount_point(&self) -> Option<&str> {
        self.mount_point.as_deref()
    }

    pub fn open(&mut self, mount_point: &str) -> Result<(), String> {
        self.close();
        let c_mount = CString::new(mount_point).map_err(|_| "invalid mount point")?;
        let mut err: *mut std::os::raw::c_char = std::ptr::null_mut();
        let db = unsafe { gpod_open(c_mount.as_ptr(), &mut err) };
        if db.is_null() {
            let msg = unsafe { take_c_string(err) }.unwrap_or_else(|| "unknown error".into());
            return Err(format!("Couldn't open iPod library: {msg}"));
        }
        self.db = Some(db);
        self.mount_point = Some(mount_point.to_string());
        self.art_gen += 1;
        // Anything still queued belonged to the library that just closed, and
        // its paths mean something different under this mount point.
        self.pending_deletes.clear();
        // Capture the connect-time state before anything can overwrite it.
        // Doing it here also makes the pair naturally consistent: nothing has
        // been written yet, so the two files still agree with each other.
        self.backup_pair();
        Ok(())
    }

    pub fn close(&mut self) {
        // Flush unsaved changes before dropping the handle — the auto-flush
        // thread can't run after close, and the user's edits must survive.
        // This is also what gets queued deletions swept: a failed flush leaves
        // them queued, and the clear below then keeps the files rather than
        // deleting audio the database still lists.
        let _ = self.flush_if_dirty();
        self.pending_deletes.clear();
        if let Some(db) = self.db.take() {
            unsafe { gpod_close(db) };
        }
        self.mount_point = None;
        self.live_refs.clear();
        self.art_cache.clear();
        self.art_order.clear();
        self.art_cache_bytes = 0;
        self.art_gen += 1;
        self.dirty = false;
        self.last_dirty_at = None;
    }

    /// Marks the library dirty — the auto-flush thread will write it to the
    /// device after a short idle window. Cheaper than save() for rapid edits.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
        self.last_dirty_at = Some(std::time::Instant::now());
        let (pending, cv) = &*self.flush_signal;
        *pending.lock().unwrap_or_else(|e| e.into_inner()) = true;
        cv.notify_one();
    }

    /// True while edits are waiting to reach the device.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Installs the channel background failures are reported through — in the
    /// app, a closure emitting a `library:flush-failed` Tauri event.
    pub fn set_error_notifier(&mut self, notify: ErrorNotifier) {
        self.notify_error = Some(notify);
    }

    /// Writes the iTunesDB only if there are unsaved changes.
    pub fn flush_if_dirty(&mut self) -> Result<(), String> {
        if self.dirty {
            self.save()?;
        }
        Ok(())
    }

    /// Copies the iTunesDB and the device's Play Counts file aside, both at the
    /// same instant and always before a write.
    ///
    /// The pairing is the point. Entries in `Play Counts` match iTunesDB tracks
    /// **positionally**, and `itdb_write` deletes the file once it has merged
    /// it — so an iTunesDB.bak restored next to a Play Counts from any other
    /// moment silently attributes plays to the wrong tracks. Backing up one
    /// without the other is worse than not backing up at all.
    ///
    /// Best-effort throughout: a device that has never been written has nothing
    /// to copy, and a failed copy must not block the user's edit from saving.
    fn backup_pair(&mut self) {
        let Some(mount) = &self.mount_point else {
            return;
        };
        let itunes = std::path::Path::new(mount).join("iPod_Control/iTunes");

        // Stage both copies to temp names first and only then rename both
        // over the .baks. Copying straight onto the .baks meant a failure on
        // the SECOND copy (full FAT32 volume, transient USB error) left a new
        // iTunesDB.bak beside a stale Play Counts.bak — a pair that silently
        // attributes plays to the wrong tracks if ever restored, worse than
        // no backup. Rename-per-file is atomic on the same volume; the
        // remaining window is process-crash between the two renames, far
        // smaller than a whole failed copy.
        let names = ["iTunesDB", "Play Counts"];
        let mut staged: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
        let mut ok = true;
        for name in names {
            let source = itunes.join(name);
            if !source.exists() {
                continue;
            }
            let tmp = itunes.join(format!("{name}.bak.tmp"));
            if std::fs::copy(&source, &tmp).is_ok() {
                staged.push((tmp, itunes.join(format!("{name}.bak"))));
            } else {
                ok = false;
                break;
            }
        }
        if ok {
            for (tmp, dest) in &staged {
                if std::fs::rename(tmp, dest).is_err() {
                    ok = false;
                }
            }
        }
        if !ok {
            for (tmp, _) in &staged {
                let _ = std::fs::remove_file(tmp);
            }
            eprintln!("backup pair refresh failed; keeping the previous pair");
            // Deliberately not fatal, and the cadence fields still advance:
            // retrying on every save against a full volume would copy tens of
            // MB over USB each flush for nothing.
        }
        self.last_backup_at = Some(std::time::Instant::now());
        self.saves_since_backup = 0;
    }

    /// The recovery point that matters is "the device as it was when you
    /// connected", so the backup is taken at open. It is refreshed occasionally
    /// afterwards to bound how much of a long session a restore would discard —
    /// but not on every write, which on a Classic means copying tens of
    /// megabytes over USB for each coalesced flush.
    fn refresh_backup_if_stale(&mut self) {
        const AFTER_SAVES: u32 = 20;
        const AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
        let stale = self.saves_since_backup >= AFTER_SAVES
            || self
                .last_backup_at
                .map(|t| t.elapsed() >= AFTER)
                .unwrap_or(true);
        if stale {
            self.backup_pair();
        }
    }

    pub fn save(&mut self) -> Result<(), String> {
        let db = self.db.ok_or("No iPod library is open.")?;
        self.refresh_backup_if_stale();
        self.saves_since_backup = self.saves_since_backup.saturating_add(1);
        let mut err: *mut std::os::raw::c_char = std::ptr::null_mut();
        if unsafe { gpod_write(db, &mut err) } == 0 {
            let msg = unsafe { take_c_string(err) }.unwrap_or_else(|| "unknown error".into());
            return Err(format!("Couldn't save changes to iPod: {msg}"));
        }
        self.dirty = false;
        self.sweep_removed_files();
        Ok(())
    }

    /// Deletes the audio behind tracks removed since the last write, now that
    /// the database on the device no longer mentions them.
    ///
    /// A path a surviving track still claims is left alone. Two records
    /// pointing at one file is not something the app creates, but it is
    /// something a database written by anything else can contain, and libgpod
    /// does not check either — deleting on the first removal would silently
    /// gut the second track.
    fn sweep_removed_files(&mut self) {
        if self.pending_deletes.is_empty() {
            return;
        }
        let queued = std::mem::take(&mut self.pending_deletes);
        let Some(mount) = self.mount_point.clone() else {
            return;
        };
        let live = self.live_ipod_paths();
        for path in queued {
            if live.contains(&path) {
                continue;
            }
            let full = device_file_path(&mount, &path);
            if let Err(e) = std::fs::remove_file(&full) {
                // Not worth failing the save over: the database is already
                // written and correct, and what is left behind is a file
                // nothing points at. Say so, so it isn't a silent leak.
                log::warn!("couldn't delete {} from the iPod: {e}", full.display());
            }
        }
    }

    /// Every device path the open database still refers to. One list walk, and
    /// only when a save actually had removals to sweep.
    fn live_ipod_paths(&self) -> HashSet<String> {
        let Some(db) = self.db else {
            return HashSet::new();
        };
        let mut count: i32 = 0;
        let array = unsafe { gpod_tracks_collect(db, &mut count) };
        if array.is_null() || count <= 0 {
            return HashSet::new();
        }
        let infos = unsafe { std::slice::from_raw_parts(array, count as usize) };
        let paths = infos
            .iter()
            .filter_map(|info| {
                (!info.ipod_path.is_null())
                    .then(|| unsafe { std::ffi::CStr::from_ptr(info.ipod_path) })
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .collect();
        unsafe { gpod_tracks_collect_free(array, count) };
        paths
    }

    /// Queues the file behind a track for deletion at the next successful
    /// save. Takes an id rather than a ref so the pointer is validated here,
    /// and must be called while the record is still live — after
    /// `gpod_remove_track` the pointer is freed and the path with it.
    pub fn queue_file_delete(&mut self, id: &str) {
        let Some(track) = self.resolve(id) else {
            return;
        };
        let mut info = std::mem::MaybeUninit::<GpodTrackInfo>::uninit();
        // SAFETY: resolve() vouched the pointer is live, and fill_info writes
        // every field of the out-param.
        let mut info = unsafe {
            gpod_track_info_for(track, info.as_mut_ptr());
            info.assume_init()
        };
        let path = if info.ipod_path.is_null() {
            String::new()
        } else {
            unsafe { std::ffi::CStr::from_ptr(info.ipod_path) }
                .to_string_lossy()
                .into_owned()
        };
        let transferred = info.transferred != 0;
        unsafe { gpod_free_track_info(&mut info) };
        // A record whose audio never reached the device has nothing to delete.
        if transferred && !path.is_empty() {
            self.pending_deletes.push(path);
        }
    }

    /// Resolves a frontend id back to a track ref, refusing anything that
    /// wasn't in the last reload.
    pub fn resolve(&self, id: &str) -> Option<GpodTrackRef> {
        let ptr: usize = id.parse().ok()?;
        self.live_refs.contains(&ptr).then_some(ptr as GpodTrackRef)
    }

    pub fn art_cache_get(&mut self, ptr: usize, size: i32) -> Option<Arc<str>> {
        let key = (ptr, size);
        let hit = self.art_cache.get(&key).cloned();
        // LRU touch: a hit moves to the back of the eviction order. The
        // linear scan is bounded by the byte budget (a few thousand entries)
        // and runs once per artwork request — noise next to the FFI extract
        // a miss costs.
        if hit.is_some() {
            if let Some(pos) = self.art_order.iter().position(|k| *k == key) {
                if let Some(k) = self.art_order.remove(pos) {
                    self.art_order.push_back(k);
                }
            }
        }
        hit
    }

    pub fn art_generation(&self) -> u64 {
        self.art_gen
    }

    /// `gen` is the generation captured under the lock that did the
    /// extraction. A mismatch means the art could have changed (replace,
    /// remove + pointer reuse, reopen) between extraction and insert — the
    /// stale result must be dropped, not cached.
    pub fn art_cache_put(&mut self, ptr: usize, size: i32, gen: u64, data_url: Arc<str>) {
        if gen != self.art_gen || !self.live_refs.contains(&ptr) {
            return;
        }
        let key = (ptr, size);
        // Re-insertion of an existing key must not double-book the deque or
        // the byte count.
        if let Some(old) = self.art_cache.get(&key) {
            self.art_cache_bytes = self.art_cache_bytes.saturating_sub(old.len());
        } else {
            self.art_order.push_back(key);
        }
        self.art_cache_bytes += data_url.len();
        self.art_cache.insert(key, data_url);
        while self.art_cache_bytes > ART_CACHE_MAX_BYTES {
            let Some(evicted) = self.art_order.pop_front() else {
                break;
            };
            if let Some(old) = self.art_cache.remove(&evicted) {
                self.art_cache_bytes = self.art_cache_bytes.saturating_sub(old.len());
            }
        }
    }

    /// Drops cached art for the given track ids — after their art changed, or
    /// after removal (a freed pointer may be reused by a later import).
    pub fn art_cache_evict(&mut self, ids: &[String]) {
        let ptrs: HashSet<usize> = ids.iter().filter_map(|id| id.parse().ok()).collect();
        let mut freed = 0usize;
        self.art_cache.retain(|(ptr, _), data_url| {
            let keep = !ptrs.contains(ptr);
            if !keep {
                freed += data_url.len();
            }
            keep
        });
        self.art_cache_bytes = self.art_cache_bytes.saturating_sub(freed);
        self.art_order.retain(|(ptr, _)| !ptrs.contains(ptr));
        self.art_gen += 1;
    }

    pub fn snapshot(&mut self) -> LibrarySnapshot {
        LibrarySnapshot {
            mount_point: self.mount_point.clone(),
            tracks: self.reload_tracks(),
            capacity: self.capacity(),
        }
    }

    /// Post-edit state of exactly the tracks an operation touched. Ids that
    /// no longer resolve are reported as removed. O(touched), not O(library):
    /// each live track is read straight through its pointer with no list walk.
    pub fn patch_for(&self, ids: &[String]) -> LibraryPatch {
        let mut updated = Vec::new();
        let mut removed_ids = Vec::new();
        for id in ids {
            match self.resolve(id) {
                Some(track) => {
                    let mut info = std::mem::MaybeUninit::<GpodTrackInfo>::uninit();
                    // SAFETY: resolve() vouched the pointer is live, and
                    // fill_info writes every field of the out-param.
                    let info = unsafe {
                        gpod_track_info_for(track, info.as_mut_ptr());
                        info.assume_init()
                    };
                    updated.push(track_from_info(&info));
                    let mut info = info;
                    unsafe { gpod_free_track_info(&mut info) };
                }
                None => removed_ids.push(id.clone()),
            }
        }
        LibraryPatch {
            updated,
            removed_ids,
            capacity: self.capacity(),
        }
    }

    /// Drops a track ref after gpod_remove_track freed it. Mutations no
    /// longer rebuild live_refs from a full reload, so without this the freed
    /// pointer would still resolve — a use-after-free on the next command
    /// that names it.
    pub fn forget(&mut self, id: &str) {
        if let Ok(ptr) = id.parse::<usize>() {
            self.live_refs.remove(&ptr);
        }
    }

    fn reload_tracks(&mut self) -> Vec<Track> {
        self.live_refs.clear();
        let Some(db) = self.db else {
            return Vec::new();
        };
        // One linear walk of the GList — gpod_track_at would restart from the
        // list head per index, which is quadratic in library size.
        let mut count: i32 = 0;
        let array = unsafe { gpod_tracks_collect(db, &mut count) };
        if array.is_null() || count <= 0 {
            return Vec::new();
        }
        let infos = unsafe { std::slice::from_raw_parts(array, count as usize) };

        let mut tracks = Vec::with_capacity(count as usize);
        for info in infos {
            self.live_refs.insert(info.track_ref as usize);
            tracks.push(track_from_info(info));
        }
        unsafe { gpod_tracks_collect_free(array, count) };

        // Base order matches the Swift app; the frontend re-sorts per view.
        tracks.sort_by_cached_key(|t| t.artist.to_lowercase());
        tracks
    }

    fn capacity(&self) -> Option<Capacity> {
        let info = crate::fsinfo::fs_info(std::path::Path::new(self.mount_point.as_deref()?))?;
        Some(Capacity {
            free_bytes: info.free_bytes as i64,
            total_bytes: info.total_bytes as i64,
        })
    }

    pub fn db(&self) -> Result<GpodDbRef, String> {
        self.db.ok_or_else(|| "No iPod library is open.".into())
    }
}

/// One Track from one C-side info struct. Shared by the full reload and the
/// per-edit patch so the two can never disagree about a field mapping.
/// Turns the database's own path for a track — `:iPod_Control:Music:F04:ABCD.mp3`
/// — into a path on this filesystem. The separator is a colon because the
/// format predates the iPod: it is the classic Mac OS one, and the leading
/// colon that would read as "relative" there is simply dropped here.
fn device_file_path(mount: &str, ipod_path: &str) -> std::path::PathBuf {
    std::path::Path::new(mount).join(ipod_path.replace(':', "/").trim_start_matches('/'))
}

fn track_from_info(info: &GpodTrackInfo) -> Track {
    let take = |p: *mut std::os::raw::c_char| -> String {
        if p.is_null() {
            String::new()
        } else {
            unsafe { std::ffi::CStr::from_ptr(p) }
                .to_string_lossy()
                .into_owned()
        }
    };
    Track {
        id: (info.track_ref as usize).to_string(),
        title: take(info.title),
        artist: take(info.artist),
        album_artist: take(info.albumartist),
        album: take(info.album),
        composer: take(info.composer),
        genre: take(info.genre),
        file_type: take(info.filetype),
        track_number: info.track_nr,
        track_count: info.track_count,
        disc_number: info.cd_nr,
        disc_count: info.disc_count,
        year: info.year,
        bitrate: info.bitrate,
        sample_rate: info.samplerate,
        duration_ms: info.duration_ms,
        size_bytes: info.size_bytes,
        date_added: (info.time_added > 0).then_some(info.time_added),
        has_artwork: info.has_artwork == 1,
        play_count: info.playcount,
        rating: info.rating,
        last_played: (info.time_played > 0).then_some(info.time_played),
        ipod_path: take(info.ipod_path),
        transferred: info.transferred == 1,
        has_drm: info.has_drm == 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_path_becomes_a_path_on_this_filesystem() {
        assert_eq!(
            device_file_path("/Volumes/POD", ":iPod_Control:Music:F04:ABCD.mp3"),
            std::path::Path::new("/Volumes/POD/iPod_Control/Music/F04/ABCD.mp3")
        );
        // Without the leading colon, as some databases store it.
        assert_eq!(
            device_file_path("/Volumes/POD", "iPod_Control:Music:F04:ABCD.mp3"),
            std::path::Path::new("/Volumes/POD/iPod_Control/Music/F04/ABCD.mp3")
        );
        // A mount point is not a path fragment to be escaped by an empty
        // record: joining nothing must not hand back the volume root, which
        // is what a delete would then be pointed at.
        assert_eq!(
            device_file_path("/Volumes/POD", ""),
            std::path::Path::new("/Volumes/POD")
        );
    }
}
