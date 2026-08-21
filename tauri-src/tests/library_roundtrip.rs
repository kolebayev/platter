//! Round-trip tests for the iTunesDB write path, driven through the real
//! libgpod FFI against a throwaway iPod skeleton in a temp directory.
//!
//! This is the regression gate for the optimizations still queued against
//! `commands.rs` and `library.rs` — per-file lock release during import,
//! delta returns instead of whole snapshots, and moving the artwork cache out
//! from under the library mutex. Each of those rewrites the code that decides
//! what ends up on a user's device, and until now none of it had any coverage.
//!
//! Every assertion that matters re-opens the database from disk. Checking the
//! in-memory copy would pass even if `itdb_write` never wrote anything.

use platter_tauri_lib::gpod::{self, GpodDbRef, GpodImportSpec, GpodTrackEdit, GpodTrackRef};
use platter_tauri_lib::library::{self, Library, Track};
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// libgpod is not thread-safe and the test harness is threaded by default, so
// every test takes this first. Poisoning is ignored: one failing test must not
// cascade into "all the rest panicked too", which would bury the real cause.
fn serialize() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A disposable iPod volume. libgpod 0.8.3 creates none of this itself, and a
/// missing piece fails in a way that looks like a code bug rather than a setup
/// one — see the fixture notes in the README.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let root =
            std::env::temp_dir().join(format!("platter-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let control = root.join("iPod_Control");
        for dir in ["iTunes", "Artwork", "Device"] {
            std::fs::create_dir_all(control.join(dir)).expect("create control dir");
        }
        // itdb_cp_track_to_ipod picks one of these at random and fails if it
        // is not already there.
        for i in 0..20 {
            std::fs::create_dir_all(control.join(format!("Music/F{i:02}"))).expect("create Fxx");
        }
        // Without a real ModelNumStr libgpod treats the device as unknown and
        // silently declines to write artwork — the failure shows up as a
        // missing thumbnail, not an error.
        std::fs::write(
            control.join("Device/SysInfo"),
            "ModelNumStr: MB565\nFirewireGuid: 000A27001CFDA3B1\n",
        )
        .expect("write SysInfo");
        Fixture { root }
    }

    fn mount(&self) -> &str {
        self.root.to_str().expect("utf-8 temp path")
    }

    /// A stub "audio" file. Import copies bytes and reads only the extension,
    /// so the contents never need to be decodable.
    fn audio(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        std::fs::write(&path, b"not really audio, but it is copied verbatim").expect("write stub");
        path
    }

    /// A 2x2 24-bit BMP. Uncompressed, so it is built exactly rather than
    /// carried around as an opaque blob, and gdk-pixbuf decodes it happily.
    fn image(&self) -> PathBuf {
        let (w, h): (i32, i32) = (2, 2);
        let row = (w * 3 + 3) & !3; // rows pad to a 4-byte boundary
        let pixels = (row * h) as u32;
        let mut bmp = Vec::new();
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(54 + pixels).to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&w.to_le_bytes());
        bmp.extend_from_slice(&h.to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&24u16.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&pixels.to_le_bytes());
        bmp.extend_from_slice(&2835i32.to_le_bytes());
        bmp.extend_from_slice(&2835i32.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        bmp.extend_from_slice(&0u32.to_le_bytes());
        for _ in 0..h {
            let mut line = vec![0u8; row as usize];
            line[0..3].copy_from_slice(&[0x20, 0x40, 0xC0]);
            line[3..6].copy_from_slice(&[0xC0, 0x40, 0x20]);
            bmp.extend_from_slice(&line);
        }
        let path = self.root.join("cover.bmp");
        std::fs::write(&path, &bmp).expect("write bmp");
        path
    }

    fn db_path(&self) -> PathBuf {
        self.root.join("iPod_Control/iTunes/iTunesDB")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Opens the fixture, hands the caller the library, and leaves it open.
fn open(fixture: &Fixture) -> Library {
    let mut lib = library::new_unmanaged();
    lib.open(fixture.mount()).expect("open library");
    lib
}

struct Meta<'a> {
    title: &'a str,
    artist: &'a str,
    album: &'a str,
    track_nr: i32,
}

fn import(lib: &Library, source: &Path, meta: Meta) -> GpodTrackRef {
    let db: GpodDbRef = lib.db().expect("db open");
    // Every CString outlives the call: inlining them into the struct literal
    // would drop the temporaries at the semicolon, leaving dangling pointers.
    let c_path = CString::new(source.to_str().unwrap()).unwrap();
    let c_title = CString::new(meta.title).unwrap();
    let c_artist = CString::new(meta.artist).unwrap();
    let c_album = CString::new(meta.album).unwrap();
    let spec = GpodImportSpec {
        source_file_path: c_path.as_ptr(),
        title: c_title.as_ptr(),
        artist: c_artist.as_ptr(),
        albumartist: std::ptr::null(),
        album: c_album.as_ptr(),
        composer: std::ptr::null(),
        genre: std::ptr::null(),
        track_nr: meta.track_nr,
        track_count: 0,
        cd_nr: 0,
        disc_count: 0,
        year: 2001,
        duration_ms: 123_000,
        bitrate: 256,
        samplerate: 44_100,
    };
    let mut err: *mut c_char = std::ptr::null_mut();
    let track = unsafe { gpod::gpod_import_track(db, &spec, &mut err) };
    if track.is_null() {
        let msg = unsafe { gpod::take_c_string(err) }.unwrap_or_else(|| "unknown".into());
        panic!("import of {} failed: {msg}", meta.title);
    }
    track
}

/// Saves, closes, and re-reads the library from disk — the only way to tell a
/// real write from an in-memory change that was never persisted.
fn save_and_reopen(lib: &mut Library, fixture: &Fixture) -> Vec<Track> {
    lib.save().expect("save");
    lib.close();
    lib.open(fixture.mount()).expect("reopen");
    lib.snapshot().tracks
}

fn find<'a>(tracks: &'a [Track], title: &str) -> &'a Track {
    tracks
        .iter()
        .find(|t| t.title == title)
        .unwrap_or_else(|| panic!("no track titled {title:?} in {:?}", titles(tracks)))
}

fn titles(tracks: &[Track]) -> Vec<&str> {
    tracks.iter().map(|t| t.title.as_str()).collect()
}

#[test]
fn open_creates_a_usable_library_on_a_bare_volume() {
    let _guard = serialize();
    let fixture = Fixture::new("bare");
    let mut lib = open(&fixture);

    assert!(lib.snapshot().tracks.is_empty());
    assert_eq!(lib.mount_point(), Some(fixture.mount()));

    lib.save().expect("save an empty library");
    assert!(fixture.db_path().exists(), "save must write an iTunesDB");

    lib.close();
    lib.open(fixture.mount())
        .expect("reopen what we just wrote");
    assert!(lib.snapshot().tracks.is_empty());
}

#[test]
fn imported_tracks_round_trip_through_save_and_reopen() {
    let _guard = serialize();
    let fixture = Fixture::new("import");
    let mut lib = open(&fixture);

    let a = fixture.audio("a.mp3");
    let b = fixture.audio("b.m4a");
    import(
        &lib,
        &a,
        Meta {
            title: "Alpha",
            artist: "Zebra",
            album: "First",
            track_nr: 1,
        },
    );
    import(
        &lib,
        &b,
        Meta {
            title: "Bravo",
            artist: "Aardvark",
            album: "Second",
            track_nr: 2,
        },
    );

    let tracks = save_and_reopen(&mut lib, &fixture);
    assert_eq!(tracks.len(), 2);

    let alpha = find(&tracks, "Alpha");
    assert_eq!(alpha.artist, "Zebra");
    assert_eq!(alpha.album, "First");
    assert_eq!(alpha.track_number, 1);
    assert_eq!(alpha.year, 2001);
    assert_eq!(alpha.duration_ms, 123_000);
    assert!(alpha.transferred, "the audio file should be on the device");
    assert!(
        alpha.ipod_path.starts_with(":iPod_Control:Music:F"),
        "unexpected device path {:?}",
        alpha.ipod_path
    );

    // The extension picks the filetype string, and that string drives which
    // unk126/unk144 pair libgpod writes — a wrong one is a knowingly bad record.
    assert!(alpha.file_type.contains("MP3"), "got {:?}", alpha.file_type);
    assert!(find(&tracks, "Bravo").file_type.contains("AAC"));

    // The file really landed where the database says it did.
    let on_disk = fixture
        .root
        .join(alpha.ipod_path.trim_start_matches(':').replace(':', "/"));
    assert!(on_disk.exists(), "missing copied file at {on_disk:?}");
}

#[test]
fn snapshot_orders_tracks_by_artist_case_insensitively() {
    let _guard = serialize();
    let fixture = Fixture::new("order");
    let mut lib = open(&fixture);

    for (name, artist) in [("One", "beta"), ("Two", "Alpha"), ("Three", "CHARLIE")] {
        let file = fixture.audio(&format!("{name}.mp3"));
        import(
            &lib,
            &file,
            Meta {
                title: name,
                artist,
                album: "X",
                track_nr: 0,
            },
        );
    }

    let tracks = save_and_reopen(&mut lib, &fixture);
    assert_eq!(titles(&tracks), vec!["Two", "One", "Three"]);
}

#[test]
fn a_metadata_edit_survives_a_reopen() {
    let _guard = serialize();
    let fixture = Fixture::new("edit");
    let mut lib = open(&fixture);
    let file = fixture.audio("a.mp3");
    let track = import(
        &lib,
        &file,
        Meta {
            title: "Before",
            artist: "Old",
            album: "Album",
            track_nr: 3,
        },
    );

    let c_title = CString::new("After").unwrap();
    let c_artist = CString::new("New").unwrap();
    let edit = GpodTrackEdit {
        title: c_title.as_ptr(),
        artist: c_artist.as_ptr(),
        ..GpodTrackEdit::unchanged()
    };
    let ok = unsafe { gpod::gpod_update_track_metadata(lib.db().unwrap(), track, &edit) };
    assert_eq!(ok, 1, "update_track_metadata reported failure");

    // Exercise the dirty/flush path the commands actually use, rather than
    // calling save() directly.
    lib.mark_dirty();
    lib.flush_if_dirty().expect("flush");
    lib.close();
    lib.open(fixture.mount()).expect("reopen");
    let tracks = lib.snapshot().tracks;

    let t = find(&tracks, "After");
    assert_eq!(t.artist, "New");
    // The null/negative sentinels mean "leave alone" — the whole reason one
    // struct can serve both the inspector save and a single-field bulk edit.
    assert_eq!(t.album, "Album", "an unset edit field must not be cleared");
    assert_eq!(
        t.track_number, 3,
        "a negative edit field must not zero the value"
    );
}

#[test]
fn flush_is_a_no_op_until_something_is_marked_dirty() {
    let _guard = serialize();
    let fixture = Fixture::new("dirty");
    let mut lib = open(&fixture);
    let file = fixture.audio("a.mp3");
    import(
        &lib,
        &file,
        Meta {
            title: "Ghost",
            artist: "A",
            album: "B",
            track_nr: 1,
        },
    );

    // Never marked dirty, so this must not write — the import stays in memory.
    lib.flush_if_dirty().expect("flush");
    assert!(
        !fixture.db_path().exists(),
        "flush_if_dirty wrote a database despite no pending changes"
    );

    lib.mark_dirty();
    lib.flush_if_dirty().expect("flush");
    assert!(fixture.db_path().exists());
}

#[test]
fn a_removed_track_does_not_come_back() {
    let _guard = serialize();
    let fixture = Fixture::new("remove");
    let mut lib = open(&fixture);
    let a = fixture.audio("a.mp3");
    let b = fixture.audio("b.mp3");
    let doomed = import(
        &lib,
        &a,
        Meta {
            title: "Doomed",
            artist: "A",
            album: "X",
            track_nr: 1,
        },
    );
    import(
        &lib,
        &b,
        Meta {
            title: "Keeper",
            artist: "A",
            album: "X",
            track_nr: 2,
        },
    );

    assert_eq!(
        unsafe { gpod::gpod_remove_track(lib.db().unwrap(), doomed) },
        1
    );

    let tracks = save_and_reopen(&mut lib, &fixture);
    assert_eq!(titles(&tracks), vec!["Keeper"]);
}

#[test]
fn artwork_set_on_a_track_is_still_there_after_a_reopen() {
    let _guard = serialize();
    let fixture = Fixture::new("art");
    let mut lib = open(&fixture);
    let file = fixture.audio("a.mp3");
    let cover = fixture.image();
    let with_art = import(
        &lib,
        &file,
        Meta {
            title: "Pretty",
            artist: "A",
            album: "X",
            track_nr: 1,
        },
    );
    let plain = fixture.audio("b.mp3");
    import(
        &lib,
        &plain,
        Meta {
            title: "Plain",
            artist: "A",
            album: "X",
            track_nr: 2,
        },
    );

    let c_cover = CString::new(cover.to_str().unwrap()).unwrap();
    let ok = unsafe { gpod::gpod_set_track_artwork(lib.db().unwrap(), with_art, c_cover.as_ptr()) };
    assert_eq!(ok, 1, "set_track_artwork reported failure");

    let tracks = save_and_reopen(&mut lib, &fixture);
    assert!(find(&tracks, "Pretty").has_artwork);
    // has_artwork is a tri-state in the format (0 = unknown), and a track left
    // at 0 is silently dropped by the Classic. "No" must stay an explicit no.
    assert!(!find(&tracks, "Plain").has_artwork);
}

#[test]
fn one_cover_can_be_stamped_across_a_whole_selection() {
    let _guard = serialize();
    let fixture = Fixture::new("bulkart");
    let mut lib = open(&fixture);
    let cover = fixture.image();

    let mut refs = Vec::new();
    for (n, title) in [(1, "One"), (2, "Two"), (3, "Three")] {
        let file = fixture.audio(&format!("{n}.mp3"));
        refs.push(import(
            &lib,
            &file,
            Meta {
                title,
                artist: "A",
                album: "X",
                track_nr: n,
            },
        ));
    }
    // One track deliberately left out, so "applied to everything" would fail
    // just as loudly as "applied to nothing".
    let untouched = fixture.audio("4.mp3");
    import(
        &lib,
        &untouched,
        Meta {
            title: "Four",
            artist: "A",
            album: "X",
            track_nr: 4,
        },
    );

    let c_cover = CString::new(cover.to_str().unwrap()).unwrap();
    let applied = unsafe {
        gpod::gpod_set_tracks_artwork(
            lib.db().unwrap(),
            refs.as_ptr(),
            refs.len() as std::os::raw::c_int,
            c_cover.as_ptr(),
        )
    };
    assert_eq!(
        applied, 3,
        "every selected track should have taken the cover"
    );

    let tracks = save_and_reopen(&mut lib, &fixture);
    for title in ["One", "Two", "Three"] {
        assert!(find(&tracks, title).has_artwork, "{title} lost its cover");
    }
    assert!(
        !find(&tracks, "Four").has_artwork,
        "a track outside the selection must not be touched"
    );
}

#[test]
fn resolve_refuses_anything_that_is_not_a_live_track() {
    let _guard = serialize();
    let fixture = Fixture::new("resolve");
    let mut lib = open(&fixture);
    let file = fixture.audio("a.mp3");
    import(
        &lib,
        &file,
        Meta {
            title: "Real",
            artist: "A",
            album: "X",
            track_nr: 1,
        },
    );

    let tracks = lib.snapshot().tracks;
    let id = tracks[0].id.clone();
    assert!(
        lib.resolve(&id).is_some(),
        "a freshly listed id must resolve"
    );

    assert!(lib.resolve("not-a-number").is_none());
    assert!(lib.resolve("0").is_none());
    assert!(lib.resolve("999999999").is_none());

    // Ids are raw pointers into the open database. Once it closes they are
    // meaningless, and handing one back to the FFI would be a use-after-free.
    lib.close();
    assert!(
        lib.resolve(&id).is_none(),
        "an id from a closed library must not resolve"
    );
}

#[test]
fn connecting_backs_up_the_database_and_play_counts_together() {
    let _guard = serialize();
    let fixture = Fixture::new("backup");
    let itunes = fixture.root.join("iPod_Control/iTunes");
    let db_bak = itunes.join("iTunesDB.bak");
    let plays = itunes.join("Play Counts");
    let plays_bak = itunes.join("Play Counts.bak");

    // A volume that has never been written has nothing to copy.
    let mut lib = open(&fixture);
    assert!(!db_bak.exists());
    let file = fixture.audio("a.mp3");
    import(
        &lib,
        &file,
        Meta {
            title: "One",
            artist: "A",
            album: "X",
            track_nr: 1,
        },
    );
    lib.save().expect("first save");
    lib.close();

    // Stand in for the plays the device recorded while it was away from us.
    std::fs::write(&plays, b"pretend play counts").expect("write Play Counts");
    let db_at_connect = std::fs::read(fixture.db_path()).expect("read db");

    lib.open(fixture.mount()).expect("reconnect");

    // Both halves are captured, and captured together. Play Counts entries
    // match iTunesDB tracks positionally and itdb_write deletes the file once
    // merged, so a database backup paired with a Play Counts from any other
    // moment would silently misattribute plays.
    assert!(db_bak.exists(), "connecting must back up the database");
    assert!(
        plays_bak.exists(),
        "connecting must back up Play Counts too"
    );
    assert_eq!(std::fs::read(&db_bak).unwrap(), db_at_connect);
    assert_eq!(std::fs::read(&plays_bak).unwrap(), b"pretend play counts");

    // Saving does not re-copy: on a Classic that is tens of megabytes over USB
    // for every coalesced flush. The recovery point stays where the user
    // connected until the refresh cadence moves it.
    //
    // This needs TWO saves to mean anything. The backup is taken before the
    // write, so after a single save a per-write backup and a per-connect one
    // hold identical bytes — only the second save, copying a database the first
    // one already changed, tells them apart.
    for (n, name) in [(2, "Two"), (3, "Three")] {
        let extra = fixture.audio(&format!("{n}.mp3"));
        import(
            &lib,
            &extra,
            Meta {
                title: name,
                artist: "A",
                album: "X",
                track_nr: n,
            },
        );
        lib.save().unwrap_or_else(|e| panic!("save {n}: {e}"));
    }
    assert_ne!(
        std::fs::read(fixture.db_path()).unwrap(),
        db_at_connect,
        "the saves should have changed the live database"
    );
    assert_eq!(
        std::fs::read(&db_bak).unwrap(),
        db_at_connect,
        "the backup must not be refreshed on every write"
    );
}

#[test]
fn the_auto_flush_thread_writes_once_the_edits_stop() {
    let _guard = serialize();
    let fixture = Fixture::new("autoflush");
    // new_shared is what the app uses: it attaches the background flusher.
    // That thread waits on a condvar, so a mark_dirty that failed to signal
    // would mean edits are simply never written — silently.
    let shared = library::new_shared();
    {
        let mut lib = shared.lock().unwrap();
        lib.open(fixture.mount()).expect("open");
        let file = fixture.audio("a.mp3");
        import(
            &lib,
            &file,
            Meta {
                title: "Later",
                artist: "A",
                album: "X",
                track_nr: 1,
            },
        );
        assert!(!fixture.db_path().exists(), "nothing should be written yet");
        lib.mark_dirty();
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !fixture.db_path().exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        fixture.db_path().exists(),
        "the auto-flush thread never wrote the database"
    );

    let mut lib = shared.lock().unwrap();
    assert!(
        !lib.is_dirty(),
        "a completed flush must clear the dirty flag"
    );
    lib.close();
}

#[test]
fn cached_artwork_is_dropped_when_the_generation_moves_on() {
    let _guard = serialize();
    let fixture = Fixture::new("artgen");
    let mut lib = open(&fixture);
    let file = fixture.audio("a.mp3");
    import(
        &lib,
        &file,
        Meta {
            title: "One",
            artist: "A",
            album: "X",
            track_nr: 1,
        },
    );

    let tracks = lib.snapshot().tracks;
    let ptr: usize = tracks[0].id.parse().unwrap();
    let generation = lib.art_generation();

    lib.art_cache_put(ptr, 80, generation, "data:image/png;base64,AAAA".into());
    assert!(lib.art_cache_get(ptr, 80).is_some());

    // An extraction that began before an invalidation must not land after it:
    // pointers are reused across imports, so a stale entry is the wrong cover
    // on the wrong track, not merely a miss.
    lib.art_cache_evict(&[ptr.to_string()]);
    assert!(
        lib.art_cache_get(ptr, 80).is_none(),
        "evict must drop the entry"
    );
    assert_ne!(
        lib.art_generation(),
        generation,
        "evict must move the generation"
    );

    lib.art_cache_put(ptr, 80, generation, "data:image/png;base64,STALE".into());
    assert!(
        lib.art_cache_get(ptr, 80).is_none(),
        "an insert carrying a superseded generation must be refused"
    );

    // A live track at the current generation still caches normally.
    let current = lib.art_generation();
    lib.art_cache_put(ptr, 80, current, "data:image/png;base64,FRESH".into());
    assert!(lib.art_cache_get(ptr, 80).is_some());

    // Unknown pointers are never cacheable, whatever generation they claim.
    lib.art_cache_put(424242, 80, lib.art_generation(), "data:x".into());
    assert!(lib.art_cache_get(424242, 80).is_none());
}

#[test]
fn removing_a_track_deletes_its_audio_but_only_after_the_write() {
    let _guard = serialize();
    let fixture = Fixture::new("removefile");
    let mut lib = open(&fixture);
    let a = fixture.audio("a.mp3");
    let b = fixture.audio("b.mp3");
    let doomed = import(
        &lib,
        &a,
        Meta {
            title: "Doomed",
            artist: "A",
            album: "X",
            track_nr: 1,
        },
    );
    import(
        &lib,
        &b,
        Meta {
            title: "Keeper",
            artist: "A",
            album: "X",
            track_nr: 2,
        },
    );

    // The device paths the import chose, before either record goes away.
    let before = lib.snapshot().tracks;
    let doomed_file = device_file(&fixture, &find(&before, "Doomed").ipod_path);
    let keeper_file = device_file(&fixture, &find(&before, "Keeper").ipod_path);
    assert!(doomed_file.exists(), "import should have copied the audio");

    lib.queue_file_delete(&find(&before, "Doomed").id.clone());
    assert_eq!(
        unsafe { gpod::gpod_remove_track(lib.db().unwrap(), doomed) },
        1
    );

    // Nothing is deleted yet: the database on the device still lists the
    // track, and a crash here has to leave a playable library behind.
    assert!(
        doomed_file.exists(),
        "the file must survive until the write that drops its record lands"
    );

    let tracks = save_and_reopen(&mut lib, &fixture);
    assert_eq!(titles(&tracks), vec!["Keeper"]);
    assert!(
        !doomed_file.exists(),
        "removing a track must take its audio with it, not leak it"
    );
    assert!(keeper_file.exists(), "the surviving track kept its audio");
}

/// The database's own colon-separated path, as a path under the fixture.
fn device_file(fixture: &Fixture, ipod_path: &str) -> PathBuf {
    Path::new(fixture.mount()).join(ipod_path.replace(':', "/").trim_start_matches('/'))
}
