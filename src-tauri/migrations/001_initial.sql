CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS books(book_id TEXT PRIMARY KEY, title TEXT, author TEXT,
  language TEXT, modified_at TEXT, last_spine_href TEXT,
  last_cfi TEXT, last_percentage REAL, last_opened_at TEXT);
CREATE TABLE IF NOT EXISTS book_overrides(book_id TEXT NOT NULL REFERENCES books(book_id)
  ON DELETE CASCADE, key TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY(book_id,key));
CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY, book_id TEXT NOT NULL
  REFERENCES books(book_id) ON DELETE CASCADE, cfi TEXT NOT NULL,
  label TEXT, chapter_href TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bookmarks_by_book ON bookmarks(book_id,created_at);
CREATE TABLE IF NOT EXISTS highlights(id TEXT PRIMARY KEY, book_id TEXT NOT NULL
  REFERENCES books(book_id) ON DELETE CASCADE, cfi_range TEXT NOT NULL,
  color TEXT NOT NULL, selected_text TEXT NOT NULL,
  quote_prefix TEXT, quote_suffix TEXT, spine_href TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS highlights_by_book ON highlights(book_id,spine_href);
CREATE TABLE IF NOT EXISTS dictionaries(dict_id TEXT PRIMARY KEY, title TEXT NOT NULL,
  path TEXT NOT NULL, source_lang TEXT, target_lang TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dictionary_entries(dict_id TEXT NOT NULL REFERENCES dictionaries(dict_id)
  ON DELETE CASCADE, term_normalized TEXT NOT NULL,
  target_offset INTEGER NOT NULL, byte_size INTEGER NOT NULL,
  PRIMARY KEY(dict_id,term_normalized,target_offset));
CREATE INDEX IF NOT EXISTS dictionary_entries_by_term ON dictionary_entries(term_normalized);
-- Search sections hold the normalized text of each spine document. offset_map_blob is reserved for a
-- future compact offset map; v0.1 resolves text offsets to CFIs in the frontend (see search.rs).
CREATE TABLE IF NOT EXISTS search_sections(book_id TEXT NOT NULL REFERENCES books(book_id)
  ON DELETE CASCADE, spine_index INTEGER NOT NULL, href TEXT NOT NULL,
  chapter_title TEXT, normalized_text TEXT NOT NULL,
  offset_map_blob BLOB NOT NULL, index_version INTEGER NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(book_id,spine_index));
