//! Full-book indexing and search.

use crate::epub::{self, decode_entities};
use crate::persistence::Db;
use regex::RegexBuilder;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

pub const INDEX_VERSION: i64 = 1;
pub const MAX_PATTERN_LEN: usize = 256;
pub const MAX_RESULTS: usize = 2000;
pub const MAX_PER_SECTION: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionStat {
    pub spine_index: usize,
    pub href: String,
    pub chars: usize,
    pub words: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub sections: Vec<SectionStat>,
    pub reused: bool,
}

/// Strips markup to normalized text.
pub fn html_to_text(html: &str) -> String {
    let b = html.as_bytes();
    let mut raw = String::with_capacity(html.len() / 2);
    let mut i = 0;
    let lower_starts = |at: usize, pat: &str| -> bool {
        b.len() >= at + pat.len() && b[at..at + pat.len()].eq_ignore_ascii_case(pat.as_bytes())
    };
    let mut text_start = 0;
    while i < b.len() {
        if b[i] == b'<' {
            raw.push_str(&html[text_start..i]);
            if lower_starts(i, "<!--") {
                i = html[i..].find("-->").map(|p| i + p + 3).unwrap_or(b.len());
            } else if lower_starts(i, "<![cdata[") {
                let end = html[i..].find("]]>").map(|p| i + p).unwrap_or(b.len());
                raw.push_str(&html[i + 9..end.max(i + 9)]);
                i = (end + 3).min(b.len());
            } else {
                let skip = ["script", "style", "head"].iter().find(|t| {
                    lower_starts(i + 1, t) && b.get(i + 1 + t.len()).is_some_and(|c| matches!(c, b'>' | b' ' | b'\n' | b'\t' | b'\r' | b'/'))
                });
                let mut j = i + 1;
                let mut q: u8 = 0;
                while j < b.len() {
                    let c = b[j];
                    if q != 0 {
                        if c == q { q = 0; }
                    } else if c == b'"' || c == b'\'' {
                        q = c;
                    } else if c == b'>' {
                        break;
                    }
                    j += 1;
                }
                let self_closing = j > 0 && j <= b.len() && b.get(j.wrapping_sub(1)) == Some(&b'/');
                i = (j + 1).min(b.len());
                if let Some(t) = skip {
                    if !self_closing {
                        let close = format!("</{t}");
                        let mut k = i;
                        let found = loop {
                            match html[k..].find("</") {
                                None => break None,
                                Some(p) => {
                                    let at = k + p;
                                    if lower_starts(at, &close) { break Some(at); }
                                    k = at + 2;
                                }
                            }
                        };
                        match found {
                            Some(at) => {
                                let mut e = at;
                                while e < b.len() && b[e] != b'>' { e += 1; }
                                i = (e + 1).min(b.len());
                            }
                            None => i = b.len(),
                        }
                    }
                }
            }
            text_start = i;
        } else {
            i += 1;
        }
    }
    if text_start < b.len() {
        raw.push_str(&html[text_start..]);
    }
    let decoded = decode_entities(&raw);
    collapse_ws(&decoded)
}

pub fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws { out.push(' '); }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

/// Counts words; CJK characters count as half a word.
pub fn count_words(text: &str) -> usize {
    let is_cjk = |c: char| matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff);
    let cjk = text.chars().filter(|c| is_cjk(*c)).count();
    let spaced: usize = text
        .split_whitespace()
        .filter(|w| !w.chars().all(is_cjk) && w.chars().any(|c| c.is_alphanumeric()))
        .count();
    spaced + cjk / 2
}

/// Builds the per-section text index, reusing a current one.
pub fn build_index(db: &Db, book_path: &std::path::Path, book_id: &str) -> Result<IndexSummary, String> {
    {
        let c = db.open_reader()?;
        let mut st = c
            .prepare("SELECT spine_index,href,length(normalized_text),words,index_version FROM search_sections WHERE book_id=?1 ORDER BY spine_index")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, String, i64, i64, i64)> = st
            .query_map(params![book_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        if !rows.is_empty() && rows.iter().all(|r| r.4 == INDEX_VERSION) {
            return Ok(IndexSummary {
                sections: rows
                    .into_iter()
                    .map(|r| SectionStat { spine_index: r.0 as usize, href: r.1, chars: r.2 as usize, words: r.3 as usize })
                    .collect(),
                reused: true,
            });
        }
    }

    let file = std::fs::File::open(book_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let pkg = epub::read_package(&mut zip)?;

    let mut stats = Vec::new();
    let mut conn = db.lock()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM search_sections WHERE book_id=?1", params![book_id]).map_err(|e| e.to_string())?;
    for (i, href) in pkg.spine.iter().enumerate() {
        let text = match epub::read_entry_bytes(&mut zip, href, epub::MAX_SECTION_BYTES) {
            Ok(bytes) => html_to_text(&String::from_utf8_lossy(&bytes)),
            Err(_) => String::new(), // unreadable section: keep the slot so spine indices line up
        };
        let words = count_words(&text);
        tx.execute(
            "INSERT INTO search_sections(book_id,spine_index,href,chapter_title,normalized_text,offset_map_blob,index_version,words)
             VALUES (?1,?2,?3,NULL,?4,x'',?5,?6)",
            params![book_id, i as i64, href, text, INDEX_VERSION, words as i64],
        )
        .map_err(|e| e.to_string())?;
        stats.push(SectionStat { spine_index: i, href: href.clone(), chars: text.chars().count(), words });
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(IndexSummary { sections: stats, reused: false })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArgs {
    pub query_id: u64,
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub spine_index: usize,
    pub href: String,
    /// UTF-16 offsets into the section text.
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub matched: String,
    pub after: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub query_id: u64,
    pub hits: Vec<Hit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDone {
    pub query_id: u64,
    pub total: usize,
    pub truncated: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

pub fn compile(pattern: &str, is_regex: bool, case_sensitive: bool) -> Result<regex::Regex, String> {
    if pattern.is_empty() {
        return Err("Enter a search term.".into());
    }
    if pattern.chars().count() > MAX_PATTERN_LEN {
        return Err(format!("Pattern is too long (max {MAX_PATTERN_LEN} characters)."));
    }
    let src = if is_regex { pattern.to_string() } else { regex::escape(pattern) };
    RegexBuilder::new(&src)
        .case_insensitive(!case_sensitive)
        .unicode(true)
        .size_limit(1 << 20)
        .dfa_size_limit(4 << 20)
        .nest_limit(50)
        .build()
        .map_err(|e| {
            let m = e.to_string();
            format!("Invalid regular expression: {}", m.lines().last().unwrap_or("syntax error").trim())
        })
}

/// Runs a query, emitting hits per section until done or superseded by a newer query id.
pub fn run_query(
    db: &Db,
    book_id: &str,
    args: &QueryArgs,
    current: &AtomicU64,
    mut emit: impl FnMut(Batch),
) -> QueryDone {
    let done = |total, truncated, cancelled, error| QueryDone { query_id: args.query_id, total, truncated, cancelled, error };
    let re = match compile(&args.pattern, args.regex, args.case_sensitive) {
        Ok(r) => r,
        Err(e) => return done(0, false, false, Some(e)),
    };
    let conn = match db.open_reader() {
        Ok(c) => c,
        Err(e) => return done(0, false, false, Some(e)),
    };
    let mut st = match conn.prepare("SELECT spine_index,href,normalized_text FROM search_sections WHERE book_id=?1 ORDER BY spine_index") {
        Ok(s) => s,
        Err(e) => return done(0, false, false, Some(e.to_string())),
    };
    let rows = match st.query_map(params![book_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))) {
        Ok(r) => r,
        Err(e) => return done(0, false, false, Some(e.to_string())),
    };
    let mut total = 0usize;
    let mut truncated = false;
    for row in rows {
        if current.load(Ordering::Relaxed) != args.query_id {
            return done(total, truncated, true, None);
        }
        let Ok((idx, href, text)) = row else { continue };
        let mut hits = Vec::new();
        let mut last_byte = 0usize;
        let mut last_u16 = 0usize;
        for m in re.find_iter(&text) {
            if m.start() == m.end() { continue; } // ignore empty matches
            if hits.len() >= MAX_PER_SECTION { truncated = true; break; }
            if total + hits.len() >= MAX_RESULTS { truncated = true; break; }
            let start16 = last_u16 + text[last_byte..m.start()].encode_utf16().count();
            let end16 = start16 + text[m.start()..m.end()].encode_utf16().count();
            last_byte = m.start();
            last_u16 = start16;
            let before: String = {
                let mut v: Vec<char> = text[..m.start()].chars().rev().take(40).collect();
                v.reverse();
                v.into_iter().collect()
            };
            let after: String = text[m.end()..].chars().take(60).collect();
            let matched: String = text[m.start()..m.end()].chars().take(200).collect();
            hits.push(Hit { spine_index: idx as usize, href: href.clone(), start: start16, end: end16, before, matched, after });
        }
        total += hits.len();
        if !hits.is_empty() {
            emit(Batch { query_id: args.query_id, hits });
        }
        if total >= MAX_RESULTS { truncated = true; break; }
    }
    done(total, truncated, false, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markup_like_the_dom() {
        let h = "<html><head><title>x</title><style>p{}</style></head><body><p>Hello <b>big</b>\n world &amp; <i>more</i></p><script>var a='<p>';</script><p>end</p></body></html>";
        assert_eq!(html_to_text(h), "Hello big world & moreend");
    }

    #[test]
    fn collapses_whitespace_without_trimming() {
        assert_eq!(collapse_ws(" a \n\t b "), " a b ");
    }

    #[test]
    fn regex_is_bounded() {
        assert!(compile("(a+)+$", true, false).is_ok()); // linear-time engine; safe by construction
        assert!(compile("(", true, false).is_err());
        assert!(compile(&"a".repeat(300), true, false).is_err());
        assert!(compile("a{1000}{1000}", true, false).is_err()); // exceeds compiled size limit
    }

    #[test]
    fn literal_is_escaped() {
        let r = compile("a.b", false, true).unwrap();
        assert!(r.is_match("a.b"));
        assert!(!r.is_match("axb"));
    }

    #[test]
    fn counts_cjk_and_latin() {
        assert_eq!(count_words("hello world"), 2);
        assert_eq!(count_words("吾輩は猫である"), 3);
    }
}
