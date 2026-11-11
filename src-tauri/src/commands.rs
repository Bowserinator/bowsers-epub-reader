//! IPC commands exposed to the UI.

use crate::dict::{self, DictInfo, ImportResult, LookupArgs, LookupResult};
use crate::epub::{BookInfo, MAX_BOOK_BYTES};
use crate::persistence::{BookState, Bookmark, Db, Highlight};
use crate::search::{self, IndexSummary, QueryArgs, QueryDone};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{ipc::Response, AppHandle, Emitter, State};

const MAX_CFI_LEN: usize = 4096;

pub struct AppState {
    /// Empty until a book is opened.
    pub book: RwLock<Option<BookInfo>>,
    pub db: Db,
    pub data_dir: PathBuf,
    pub lru: Mutex<dict::Lru>,
    pub current_query: AtomicU64,
}

impl AppState {
    fn current(&self) -> Result<Option<BookInfo>, String> {
        self.book.read().map(|b| b.clone()).map_err(|_| "state poisoned".to_string())
    }

    pub fn book(&self) -> Result<BookInfo, String> {
        self.current()?.ok_or_else(|| "no book is open".to_string())
    }
    fn check(&self, id: &str) -> Result<(), String> {
        if id == self.book()?.book_id { Ok(()) } else { Err("book id does not match the open book".into()) }
    }
}

type R<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    #[serde(flatten)]
    pub book: BookInfo,
    pub state: BookState,
}

fn launch_info(s: &AppState, book: BookInfo) -> R<LaunchInfo> {
    let state = s.db.ensure_book(&book.book_id, &book.title, &book.author, &book.language)?;
    Ok(LaunchInfo { book, state })
}

/// None when no book is open.
#[tauri::command]
pub fn get_launch_book(s: State<'_, Arc<AppState>>) -> R<Option<LaunchInfo>> {
    match s.current()? {
        Some(b) => launch_info(&s, b).map(Some),
        None => Ok(None),
    }
}

/// Opens a book chosen in the file dialog; one book per process.
#[tauri::command]
pub async fn open_book(app: AppHandle, s: State<'_, Arc<AppState>>, path: String) -> R<LaunchInfo> {
    if s.current()?.is_some() {
        return Err("a book is already open in this window".into());
    }
    let p = crate::epub::expand_tilde(std::path::Path::new(&path));
    let info = tauri::async_runtime::spawn_blocking(move || crate::epub::open_and_validate(&p))
        .await
        .map_err(|e| e.to_string())??;
    *s.book.write().map_err(|_| "state poisoned".to_string())? = Some(info.clone());
    if let Some(w) = tauri::Manager::get_webview_window(&app, "main") {
        let _ = w.set_title(&crate::window_title(Some(&info)));
    }
    launch_info(&s, info)
}

/// Bytes of the open book.
#[tauri::command]
pub async fn read_book_bytes(s: State<'_, Arc<AppState>>) -> R<Response> {
    let book = s.book()?;
    let path = book.path.clone();
    let id = book.book_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| format!("cannot read book: {e}"))?;
        if meta.len() > MAX_BOOK_BYTES { return Err("book too large".to_string()); }
        let bytes = std::fs::read(&path).map_err(|e| format!("cannot read book: {e}"))?;
        // The file must not have changed since it was opened.
        if hex::encode(Sha256::digest(&bytes)) != id {
            return Err("the book file changed on disk after launch; please reopen it".to_string());
        }
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn save_reading_position(s: State<'_, Arc<AppState>>, book_id: String, cfi: String, percentage: f64, spine_href: Option<String>) -> R<()> {
    s.check(&book_id)?;
    if cfi.len() > MAX_CFI_LEN { return Err("cfi too long".into()); }
    s.db.save_position(&book_id, &cfi, percentage, &spine_href)
}

#[tauri::command]
pub fn settings_get(s: State<'_, Arc<AppState>>) -> R<HashMap<String, Value>> { s.db.settings_get() }

#[tauri::command]
pub fn settings_update(s: State<'_, Arc<AppState>>, patch: HashMap<String, Value>) -> R<()> { s.db.settings_update(patch) }

#[tauri::command]
pub fn book_override_list(s: State<'_, Arc<AppState>>, book_id: String) -> R<HashMap<String, Value>> {
    s.check(&book_id)?;
    s.db.override_list(&book_id)
}

#[tauri::command]
pub fn book_override_set(s: State<'_, Arc<AppState>>, book_id: String, key: String, value: Value) -> R<()> {
    s.check(&book_id)?;
    s.db.override_set(&book_id, &key, &value)
}

#[tauri::command]
pub fn book_override_delete(s: State<'_, Arc<AppState>>, book_id: String, key: Option<String>) -> R<()> {
    s.check(&book_id)?;
    s.db.override_delete(&book_id, key.as_deref())
}

#[tauri::command]
pub fn bookmark_list(s: State<'_, Arc<AppState>>, book_id: String) -> R<Vec<Bookmark>> {
    s.check(&book_id)?;
    s.db.bookmark_list(&book_id)
}

#[tauri::command]
pub fn bookmark_upsert(s: State<'_, Arc<AppState>>, book_id: String, bookmark: Bookmark) -> R<()> {
    s.check(&book_id)?;
    if bookmark.cfi.len() > MAX_CFI_LEN { return Err("cfi too long".into()); }
    s.db.bookmark_upsert(&book_id, &bookmark)
}

#[tauri::command]
pub fn bookmark_delete(s: State<'_, Arc<AppState>>, book_id: String, id: String) -> R<()> {
    s.check(&book_id)?;
    s.db.bookmark_delete(&book_id, &id)
}

#[tauri::command]
pub fn highlight_list(s: State<'_, Arc<AppState>>, book_id: String) -> R<Vec<Highlight>> {
    s.check(&book_id)?;
    s.db.highlight_list(&book_id)
}

#[tauri::command]
pub fn highlight_upsert(s: State<'_, Arc<AppState>>, book_id: String, highlight: Highlight) -> R<()> {
    s.check(&book_id)?;
    if highlight.selected_text.len() > 20_000 || highlight.cfi_range.len() > MAX_CFI_LEN { return Err("highlight too large".into()); }
    if !["yellow", "mint", "pink", "blue", "violet"].contains(&highlight.color.as_str()) { return Err("unknown colour".into()); }
    s.db.highlight_upsert(&book_id, &highlight)
}

#[tauri::command]
pub fn highlight_delete(s: State<'_, Arc<AppState>>, book_id: String, id: String) -> R<()> {
    s.check(&book_id)?;
    s.db.highlight_delete(&book_id, &id)
}

#[tauri::command]
pub async fn list_system_fonts() -> R<Vec<String>> {
    tauri::async_runtime::spawn_blocking(crate::fonts::list_families).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn dictionary_import(s: State<'_, Arc<AppState>>, paths: Vec<String>) -> R<ImportResult> {
    let st = s.inner().clone();
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || dict::import(&st.db, &st.data_dir, &paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dictionary_list(s: State<'_, Arc<AppState>>) -> R<Vec<DictInfo>> { dict::list(&s.db) }

#[tauri::command]
pub fn dictionary_update(s: State<'_, Arc<AppState>>, dict_id: String, enabled: Option<bool>, priority: Option<i64>, source_lang: Option<String>, target_lang: Option<String>) -> R<()> {
    dict::update(&s.db, &dict_id, enabled, priority, source_lang, target_lang)
}

#[tauri::command]
pub fn dictionary_remove(s: State<'_, Arc<AppState>>, dict_id: String) -> R<()> { dict::remove(&s.db, &s.data_dir, &dict_id) }

#[tauri::command]
pub fn dictionary_lookup(s: State<'_, Arc<AppState>>, args: LookupArgs) -> R<LookupResult> {
    let mut lru = s.lru.lock().map_err(|_| "cache lock poisoned".to_string())?;
    dict::lookup(&s.db, &s.data_dir, &mut lru, &args)
}
#[tauri::command]
pub async fn search_build_index(s: State<'_, Arc<AppState>>, book_id: String) -> R<IndexSummary> {
    s.check(&book_id)?;
    let st = s.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let b = st.book()?; search::build_index(&st.db, &b.path, &b.book_id) })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_query(app: AppHandle, s: State<'_, Arc<AppState>>, args: QueryArgs) -> R<QueryDone> {
    s.current_query.store(args.query_id, Ordering::SeqCst);
    let st = s.inner().clone();
    let id = s.book()?.book_id;
    tauri::async_runtime::spawn_blocking(move || {
        search::run_query(&st.db, &id, &args, &st.current_query, |b| {
            let _ = app.emit("search-batch", b);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_cancel(s: State<'_, Arc<AppState>>) { s.current_query.store(0, Ordering::SeqCst); }
