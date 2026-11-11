pub mod commands;
pub mod console;
pub mod dict;
pub mod epub;
pub mod fonts;
pub mod persistence;
pub mod search;
pub mod window_state;

use commands::AppState;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use tauri::Manager;

pub const APP_NAME: &str = "Bowser's Epub Reader";

pub fn window_title(book: Option<&epub::BookInfo>) -> String {
    let name = book.and_then(|b| b.title.as_deref().filter(|t| !t.is_empty()).or(Some(b.file_name.as_str())));
    match name {
        Some(n) => format!("{n} — {APP_NAME}"),
        None => APP_NAME.to_string(),
    }
}

/// WebKitGTK's DMABUF renderer fails on some GPU/driver stacks and leaves the window blank.
#[cfg(target_os = "linux")]
fn configure_webkit() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_webkit() {}

pub fn run(book: Option<epub::BookInfo>) {
    configure_webkit();
    let title = window_title(book.as_ref());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let db = persistence::Db::open(&data_dir).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(Arc::new(AppState {
                book: RwLock::new(book.clone()),
                db,
                data_dir: data_dir.clone(),
                lru: Mutex::new(dict::Lru::new(256)),
                current_query: AtomicU64::new(0),
            }));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&title);
                window_state::restore_and_track(&w, data_dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_launch_book,
            commands::open_book,
            commands::read_book_bytes,
            commands::save_reading_position,
            commands::settings_get,
            commands::settings_update,
            commands::book_override_list,
            commands::book_override_set,
            commands::book_override_delete,
            commands::bookmark_list,
            commands::bookmark_upsert,
            commands::bookmark_delete,
            commands::highlight_list,
            commands::highlight_upsert,
            commands::highlight_delete,
            commands::list_system_fonts,
            commands::dictionary_import,
            commands::dictionary_list,
            commands::dictionary_update,
            commands::dictionary_remove,
            commands::dictionary_lookup,
            commands::search_build_index,
            commands::search_query,
            commands::search_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bowser's Epub Reader");
}
