//! CiRoom desktop core.
//!
//! Stage 2 adds modules here: `db` (SQLite), `library` (scanner), `player` (mpv IPC),
//! `metadata` (TMDB). Commands stay thin and delegate to those modules.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running CiRoom");
}
