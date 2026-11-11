//! SQLite storage.

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/001_initial.sql"))];

/// Settings keys the UI may write.
pub const SETTING_KEYS: &[&str] = &[
    "theme", "fontFamilyId", "fontSizePx", "lineHeight", "textAlign", "pageMarginPx", "readerMode", "pageSurface",
    "showChapterRunningHeader", "showPageNumber", "hoverDefine", "dictionaryMode", "activeDictionaryIds", "autoHideControls",
    "readingSpeedWpm", "showTitle", "reducedAnimations", "remainingMode",
];
/// Keys a book may override, plus the enable flag.
pub const OVERRIDE_KEYS: &[&str] = &[
    "theme", "fontFamilyId", "fontSizePx", "lineHeight", "textAlign", "pageMarginPx", "readerMode", "pageSurface",
    "showChapterRunningHeader", "showPageNumber", "_enabled",
];

pub struct Db {
    pub path: PathBuf,
    pub conn: Mutex<Connection>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Reads (key, JSON text) rows into a map, skipping values that are not valid JSON.
fn json_map(st: &mut rusqlite::Statement<'_>, params: impl rusqlite::Params) -> rusqlite::Result<HashMap<String, Value>> {
    let rows = st.query_map(params, |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut m = HashMap::new();
    for r in rows {
        let (k, v) = r?;
        if let Ok(j) = serde_json::from_str::<Value>(&v) {
            m.insert(k, j);
        }
    }
    Ok(m)
}

impl Db {
    pub fn open(dir: &Path) -> Result<Db, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create data dir: {e}"))?;
        let path = dir.join("bowsers.db");
        let existed = path.exists();
        let mut conn = Connection::open(&path).map_err(|e| format!("cannot open database: {e}"))?;
        conn.busy_timeout(BUSY_TIMEOUT).ok();
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        Self::migrate(&mut conn, &path, existed)?;
        Ok(Db { path, conn: Mutex::new(conn) })
    }

    fn migrate(conn: &mut Connection, path: &Path, existed: bool) -> Result<(), String> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);")
            .map_err(|e| e.to_string())?;
        let current: i64 = conn
            .query_row("SELECT COALESCE(MAX(version),0) FROM schema_migrations", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let latest = MIGRATIONS.last().map(|m| m.0).unwrap_or(0);
        if current >= latest {
            return Ok(());
        }
        if existed && current > 0 {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
            let bak = path.with_extension(format!("db.bak-v{current}"));
            let tmp = path.with_extension("db.bak-tmp");
            std::fs::copy(path, &tmp).and_then(|_| std::fs::rename(&tmp, &bak)).map_err(|e| format!("backup failed: {e}"))?;
        }
        for (v, sql) in MIGRATIONS.iter().filter(|m| m.0 > current) {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(sql).map_err(|e| format!("migration {v}: {e}"))?;
            tx.execute("INSERT INTO schema_migrations(version) VALUES (?1)", params![v]).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Read-only connection that does not block writers.
    pub fn open_reader(&self) -> Result<Connection, String> {
        let c = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| e.to_string())?;
        c.busy_timeout(BUSY_TIMEOUT).ok();
        Ok(c)
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn.lock().map_err(|_| "database lock poisoned".to_string())
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let mut g = self.lock()?;
        f(&mut g).map_err(|e| e.to_string())
    }
    pub fn settings_get(&self) -> Result<HashMap<String, Value>, String> {
        self.with(|c| {
            let mut st = c.prepare("SELECT key, value_json FROM settings")?;
            json_map(&mut st, params![])
        })
    }

    pub fn settings_update(&self, patch: HashMap<String, Value>) -> Result<(), String> {
        for (k, v) in &patch {
            if !SETTING_KEYS.contains(&k.as_str()) {
                return Err(format!("unknown setting '{k}'"));
            }
            if v.to_string().len() > 65_536 {
                return Err(format!("setting '{k}' too large"));
            }
        }
        self.with(|c| {
            let tx = c.transaction()?;
            for (k, v) in &patch {
                tx.execute(
                    "INSERT INTO settings(key,value_json,updated_at) VALUES (?1,?2,?3)
                     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
                    params![k, v.to_string(), now_iso()],
                )?;
            }
            tx.commit()
        })
    }
    pub fn ensure_book(&self, id: &str, title: &Option<String>, author: &Option<String>, lang: &Option<String>) -> Result<BookState, String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO books(book_id,title,author,language,last_opened_at) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(book_id) DO UPDATE SET title=excluded.title, author=excluded.author,
                   language=excluded.language, last_opened_at=excluded.last_opened_at",
                params![id, title, author, lang, now_iso()],
            )?;
            c.query_row("SELECT last_cfi,last_percentage,last_spine_href FROM books WHERE book_id=?1", params![id], |r| {
                Ok(BookState { last_cfi: r.get(0)?, last_percentage: r.get(1)?, last_spine_href: r.get(2)? })
            })
        })
    }

    pub fn save_position(&self, id: &str, cfi: &str, pct: f64, href: &Option<String>) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "UPDATE books SET last_cfi=?2,last_percentage=?3,last_spine_href=?4,last_opened_at=?5 WHERE book_id=?1",
                params![id, cfi, pct.clamp(0.0, 1.0), href, now_iso()],
            )?;
            Ok(())
        })
    }

    pub fn override_list(&self, id: &str) -> Result<HashMap<String, Value>, String> {
        self.with(|c| {
            let mut st = c.prepare("SELECT key,value_json FROM book_overrides WHERE book_id=?1")?;
            json_map(&mut st, params![id])
        })
    }

    pub fn override_set(&self, id: &str, key: &str, value: &Value) -> Result<(), String> {
        if !OVERRIDE_KEYS.contains(&key) {
            return Err(format!("'{key}' cannot be overridden per book"));
        }
        self.with(|c| {
            c.execute(
                "INSERT INTO book_overrides(book_id,key,value_json) VALUES (?1,?2,?3)
                 ON CONFLICT(book_id,key) DO UPDATE SET value_json=excluded.value_json",
                params![id, key, value.to_string()],
            )?;
            Ok(())
        })
    }

    /// Deletes one override, or all of them when `key` is None.
    pub fn override_delete(&self, id: &str, key: Option<&str>) -> Result<(), String> {
        self.with(|c| {
            match key {
                Some(k) => c.execute("DELETE FROM book_overrides WHERE book_id=?1 AND key=?2", params![id, k])?,
                None => c.execute("DELETE FROM book_overrides WHERE book_id=?1", params![id])?,
            };
            Ok(())
        })
    }
    pub fn bookmark_list(&self, id: &str) -> Result<Vec<Bookmark>, String> {
        self.with(|c| {
            let mut st = c.prepare("SELECT id,cfi,label,chapter_href,created_at FROM bookmarks WHERE book_id=?1 ORDER BY created_at")?;
            let rows = st.query_map(params![id], |r| {
                Ok(Bookmark { id: r.get(0)?, cfi: r.get(1)?, label: r.get(2)?, chapter_href: r.get(3)?, created_at: r.get(4)? })
            })?;
            rows.collect()
        })
    }

    pub fn bookmark_upsert(&self, book: &str, b: &Bookmark) -> Result<(), String> {
        self.with(|c| {
            c.execute(
                "INSERT INTO bookmarks(id,book_id,cfi,label,chapter_href,created_at) VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(id) DO UPDATE SET cfi=excluded.cfi,label=excluded.label,chapter_href=excluded.chapter_href",
                params![b.id, book, b.cfi, b.label, b.chapter_href, b.created_at],
            )?;
            Ok(())
        })
    }

    pub fn bookmark_delete(&self, book: &str, id: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute("DELETE FROM bookmarks WHERE book_id=?1 AND id=?2", params![book, id])?;
            Ok(())
        })
    }
    pub fn highlight_list(&self, id: &str) -> Result<Vec<Highlight>, String> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT id,cfi_range,color,selected_text,quote_prefix,quote_suffix,spine_href,created_at,updated_at
                 FROM highlights WHERE book_id=?1 ORDER BY created_at",
            )?;
            let rows = st.query_map(params![id], |r| {
                Ok(Highlight {
                    id: r.get(0)?, cfi_range: r.get(1)?, color: r.get(2)?, selected_text: r.get(3)?,
                    quote_prefix: r.get(4)?, quote_suffix: r.get(5)?, spine_href: r.get(6)?,
                    created_at: r.get(7)?, updated_at: r.get(8)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Replaces a highlight on the same range; overlapping ranges coexist.
    pub fn highlight_upsert(&self, book: &str, h: &Highlight) -> Result<(), String> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM highlights WHERE book_id=?1 AND cfi_range=?2 AND id<>?3",
                params![book, h.cfi_range, h.id],
            )?;
            tx.execute(
                "INSERT INTO highlights(id,book_id,cfi_range,color,selected_text,quote_prefix,quote_suffix,spine_href,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(id) DO UPDATE SET color=excluded.color, updated_at=excluded.updated_at",
                params![h.id, book, h.cfi_range, h.color, h.selected_text, h.quote_prefix, h.quote_suffix, h.spine_href, h.created_at, h.updated_at],
            )?;
            tx.commit()
        })
    }

    pub fn highlight_delete(&self, book: &str, id: &str) -> Result<(), String> {
        self.with(|c| {
            c.execute("DELETE FROM highlights WHERE book_id=?1 AND id=?2", params![book, id])?;
            Ok(())
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookState {
    pub last_cfi: Option<String>,
    pub last_percentage: Option<f64>,
    pub last_spine_href: Option<String>,
}

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub cfi: String,
    pub label: Option<String>,
    pub chapter_href: Option<String>,
    pub created_at: String,
}

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub cfi_range: String,
    pub color: String,
    pub selected_text: String,
    pub quote_prefix: Option<String>,
    pub quote_suffix: Option<String>,
    pub spine_href: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bowsers-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn bookmarks_persist_and_cascade() {
        let dir = tmp();
        let db = Db::open(&dir).unwrap();
        db.ensure_book("abc", &Some("T".into()), &None, &None).unwrap();
        let b = Bookmark { id: "1".into(), cfi: "epubcfi(/6/2)".into(), label: Some("x".into()), chapter_href: None, created_at: now_iso() };
        db.bookmark_upsert("abc", &b).unwrap();
        drop(db);
        let db = Db::open(&dir).unwrap();
        assert_eq!(db.bookmark_list("abc").unwrap().len(), 1);
        db.bookmark_delete("abc", "1").unwrap();
        assert!(db.bookmark_list("abc").unwrap().is_empty());
    }

    #[test]
    fn rejects_unknown_settings() {
        let db = Db::open(&tmp()).unwrap();
        let mut m = HashMap::new();
        m.insert("evil".to_string(), Value::Bool(true));
        assert!(db.settings_update(m).is_err());
    }

    #[test]
    fn highlight_same_range_replaces() {
        let db = Db::open(&tmp()).unwrap();
        db.ensure_book("b", &None, &None, &None).unwrap();
        let mk = |id: &str, color: &str| Highlight {
            id: id.into(), cfi_range: "r".into(), color: color.into(), selected_text: "t".into(),
            quote_prefix: None, quote_suffix: None, spine_href: None, created_at: now_iso(), updated_at: now_iso(),
        };
        db.highlight_upsert("b", &mk("1", "yellow")).unwrap();
        db.highlight_upsert("b", &mk("2", "pink")).unwrap();
        let l = db.highlight_list("b").unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].color, "pink");
    }
}
