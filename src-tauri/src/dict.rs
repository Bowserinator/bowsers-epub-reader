//! StarDict dictionary import and lookup.

use crate::persistence::{now_iso, Db};
use flate2::read::GzDecoder;
use flate2::{Decompress, FlushDecompress};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

const MAX_IDX_BYTES: u64 = 512 << 20;
const MAX_ENTRIES: usize = 5_000_000;
const MAX_WORD_BYTES: usize = 256;
const MAX_ENTRY_BYTES: u32 = 4 << 20;
const MAX_DICT_BYTES: u64 = 4 << 30;
const MAX_IFO_BYTES: u64 = 1 << 20;
const MAX_SYN_BYTES: u64 = 64 << 20;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ifo {
    pub version: String,
    pub bookname: String,
    pub wordcount: u64,
    pub synwordcount: u64,
    pub idxfilesize: u64,
    pub idxoffsetbits: u32,
    pub sametypesequence: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub website: Option<String>,
    pub date: Option<String>,
}

pub fn parse_ifo(text: &str) -> Result<Ifo, String> {
    let mut lines = text.lines();
    let first = lines.next().unwrap_or("").trim_start_matches('\u{feff}').trim();
    if first != "StarDict's dict ifo file" {
        return Err("not a StarDict .ifo file (bad magic line)".into());
    }
    let mut kv = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once('=') {
            kv.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let version = kv.get("version").cloned().ok_or("missing 'version' in .ifo")?;
    if version != "2.4.2" && version != "3.0.0" {
        return Err(format!("unsupported StarDict version '{version}'"));
    }
    let num = |k: &str| -> Result<u64, String> {
        kv.get(k).map(|v| v.parse::<u64>().map_err(|_| format!("bad '{k}' in .ifo"))).unwrap_or(Ok(0))
    };
    let bits = kv.get("idxoffsetbits").map(|v| v.parse::<u32>().unwrap_or(0)).unwrap_or(32);
    if bits != 32 && bits != 64 {
        return Err(format!("unsupported idxoffsetbits {bits}"));
    }
    Ok(Ifo {
        version,
        bookname: kv.get("bookname").cloned().filter(|s| !s.is_empty()).ok_or("missing 'bookname' in .ifo")?,
        wordcount: num("wordcount")?,
        synwordcount: num("synwordcount")?,
        idxfilesize: num("idxfilesize")?,
        idxoffsetbits: bits,
        sametypesequence: kv.get("sametypesequence").cloned(),
        description: kv.get("description").cloned(),
        author: kv.get("author").cloned(),
        website: kv.get("website").cloned(),
        date: kv.get("date").cloned(),
    })
}

pub struct IdxEntry {
    pub word: String,
    pub offset: u64,
    pub size: u32,
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let f = File::open(path).map_err(|e| format!("{name}: {e}"))?;
    let gz = name.ends_with(".gz") || name.ends_with(".dz");
    let mut out = Vec::new();
    let r: Box<dyn Read> = if gz { Box::new(GzDecoder::new(f)) } else { Box::new(f) };
    r.take(limit + 1).read_to_end(&mut out).map_err(|e| format!("{name}: {e}"))?;
    if out.len() as u64 > limit {
        return Err(format!("{name}: exceeds the {} MiB limit", limit >> 20));
    }
    Ok(out)
}

pub fn parse_idx(data: &[u8], bits: u32, dict_size: u64) -> Result<Vec<IdxEntry>, String> {
    let off_len = if bits == 64 { 8 } else { 4 };
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let end = data[i..].iter().position(|&b| b == 0).ok_or("truncated .idx: unterminated word")? + i;
        let wlen = end - i;
        if wlen == 0 || wlen > MAX_WORD_BYTES {
            return Err(format!("invalid .idx: word length {wlen} at byte {i}"));
        }
        let word = std::str::from_utf8(&data[i..end]).map_err(|_| "invalid .idx: headword is not UTF-8")?.to_string();
        let p = end + 1;
        if p + off_len + 4 > data.len() {
            return Err("truncated .idx: missing offset/size".into());
        }
        let offset = if bits == 64 {
            u64::from_be_bytes(data[p..p + 8].try_into().unwrap())
        } else {
            u32::from_be_bytes(data[p..p + 4].try_into().unwrap()) as u64
        };
        let size = u32::from_be_bytes(data[p + off_len..p + off_len + 4].try_into().unwrap());
        if size > MAX_ENTRY_BYTES {
            return Err(format!("invalid .idx: entry size {size} out of range"));
        }
        if offset.checked_add(size as u64).map_or(true, |e| e > dict_size) {
            return Err("invalid .idx: entry points outside the .dict data".into());
        }
        out.push(IdxEntry { word, offset, size });
        if out.len() > MAX_ENTRIES {
            return Err("dictionary has too many entries".into());
        }
        i = p + off_len + 4;
    }
    Ok(out)
}

/// Parses synonym entries as (word, entry index).
pub fn parse_syn(data: &[u8], n_entries: usize) -> Result<Vec<(String, usize)>, String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let end = data[i..].iter().position(|&b| b == 0).ok_or("truncated .syn")? + i;
        if end == i || end - i > MAX_WORD_BYTES {
            return Err("invalid .syn word".into());
        }
        let w = std::str::from_utf8(&data[i..end]).map_err(|_| "invalid .syn: not UTF-8")?.to_string();
        if end + 5 > data.len() {
            return Err("truncated .syn".into());
        }
        let idx = u32::from_be_bytes(data[end + 1..end + 5].try_into().unwrap()) as usize;
        if idx >= n_entries {
            return Err("invalid .syn: index out of range".into());
        }
        out.push((w, idx));
        i = end + 5;
    }
    Ok(out)
}

pub struct DictZip {
    file: File,
    chunk_len: usize,
    starts: Vec<u64>,
    sizes: Vec<u16>,
    pub uncompressed: u64,
}

impl DictZip {
    pub fn open(path: &Path) -> Result<DictZip, String> {
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        let flen = f.metadata().map_err(|e| e.to_string())?.len();
        let mut h = [0u8; 10];
        f.read_exact(&mut h).map_err(|_| "dictzip: file too short")?;
        if h[0] != 0x1f || h[1] != 0x8b || h[2] != 8 {
            return Err("dictzip: not a gzip file".into());
        }
        let flg = h[3];
        if flg & 4 == 0 {
            return Err("dictzip: missing random-access header (plain gzip is not supported; use .dict or dictzip)".into());
        }
        let mut xl = [0u8; 2];
        f.read_exact(&mut xl).map_err(|_| "dictzip: truncated")?;
        let xlen = u16::from_le_bytes(xl) as usize;
        let mut extra = vec![0u8; xlen];
        f.read_exact(&mut extra).map_err(|_| "dictzip: truncated")?;
        let (mut chunk_len, mut sizes) = (0usize, Vec::new());
        let mut p = 0;
        while p + 4 <= extra.len() {
            let sl = u16::from_le_bytes([extra[p + 2], extra[p + 3]]) as usize;
            if p + 4 + sl > extra.len() { break; }
            if extra[p] == b'R' && extra[p + 1] == b'A' && sl >= 6 {
                let d = &extra[p + 4..p + 4 + sl];
                chunk_len = u16::from_le_bytes([d[2], d[3]]) as usize;
                let cnt = u16::from_le_bytes([d[4], d[5]]) as usize;
                if d.len() < 6 + cnt * 2 { return Err("dictzip: bad chunk table".into()); }
                sizes = (0..cnt).map(|k| u16::from_le_bytes([d[6 + 2 * k], d[7 + 2 * k]])).collect();
            }
            p += 4 + sl;
        }
        if chunk_len == 0 || sizes.is_empty() {
            return Err("dictzip: no chunk table found".into());
        }
        let skip_z = |f: &mut File| -> Result<(), String> {
            let mut b = [0u8; 1];
            loop {
                f.read_exact(&mut b).map_err(|_| "dictzip: truncated header")?;
                if b[0] == 0 { return Ok(()); }
            }
        };
        if flg & 8 != 0 { skip_z(&mut f)?; }
        if flg & 16 != 0 { skip_z(&mut f)?; }
        if flg & 2 != 0 { f.seek(SeekFrom::Current(2)).map_err(|e| e.to_string())?; }
        let data_start = f.stream_position().map_err(|e| e.to_string())?;
        let mut starts = Vec::with_capacity(sizes.len());
        let mut acc = data_start;
        for s in &sizes {
            starts.push(acc);
            acc += *s as u64;
        }
        if acc > flen { return Err("dictzip: chunk table exceeds file size".into()); }
        f.seek(SeekFrom::End(-4)).map_err(|e| e.to_string())?;
        let mut isz = [0u8; 4];
        f.read_exact(&mut isz).map_err(|e| e.to_string())?;
        let uncompressed = u32::from_le_bytes(isz) as u64;
        if uncompressed > (sizes.len() as u64) * (chunk_len as u64) {
            return Err("dictzip: size/chunk mismatch".into());
        }
        Ok(DictZip { file: f, chunk_len, starts, sizes, uncompressed })
    }

    pub fn read_at(&mut self, offset: u64, size: u32) -> Result<Vec<u8>, String> {
        if size > MAX_ENTRY_BYTES || offset + size as u64 > self.uncompressed {
            return Err("entry outside dictionary".into());
        }
        let cl = self.chunk_len as u64;
        let first = (offset / cl) as usize;
        let last = ((offset + size as u64 - 1) / cl) as usize;
        if last >= self.sizes.len() { return Err("entry outside chunk table".into()); }
        let mut buf = Vec::with_capacity(((last - first + 1) * self.chunk_len).min(8 << 20));
        for c in first..=last {
            self.file.seek(SeekFrom::Start(self.starts[c])).map_err(|e| e.to_string())?;
            let mut comp = vec![0u8; self.sizes[c] as usize];
            self.file.read_exact(&mut comp).map_err(|e| e.to_string())?;
            buf.extend_from_slice(&inflate_chunk(&comp, self.chunk_len)?);
        }
        let skip = (offset - first as u64 * cl) as usize;
        buf.get(skip..skip + size as usize).map(|s| s.to_vec()).ok_or_else(|| "dictzip: short read".to_string())
    }
}

/// Inflates one dictzip chunk. Chunks end at a flush point instead of a final block, which streaming decoders reject as truncated.
fn inflate_chunk(comp: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(max + 1);
    Decompress::new(false)
        .decompress_vec(comp, &mut out, FlushDecompress::Sync)
        .map_err(|e| format!("dictzip inflate: {e}"))?;
    if out.len() > max { return Err("dictzip: chunk too large".into()); }
    Ok(out)
}

pub enum DictData {
    Plain(File, u64),
    Zip(DictZip),
}

impl DictData {
    pub fn open(dir: &Path) -> Result<DictData, String> {
        let dz = dir.join("dict.dict.dz");
        if dz.exists() {
            return Ok(DictData::Zip(DictZip::open(&dz)?));
        }
        let p = dir.join("dict.dict");
        let f = File::open(&p).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        Ok(DictData::Plain(f, len))
    }
    pub fn read_at(&mut self, offset: u64, size: u32) -> Result<Vec<u8>, String> {
        match self {
            DictData::Plain(f, len) => {
                if size > MAX_ENTRY_BYTES || offset + size as u64 > *len { return Err("entry outside dictionary".into()); }
                f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
                let mut b = vec![0u8; size as usize];
                f.read_exact(&mut b).map_err(|e| e.to_string())?;
                Ok(b)
            }
            DictData::Zip(z) => z.read_at(offset, size),
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn sanitize_html(html: &str) -> String {
    let tags: HashSet<&str> = [
        "b", "i", "u", "em", "strong", "p", "br", "ul", "ol", "li", "span", "div", "sub", "sup", "small",
        "table", "thead", "tbody", "tr", "td", "th", "blockquote", "code", "pre", "h1", "h2", "h3", "h4",
        "h5", "h6", "dl", "dt", "dd", "hr",
    ]
    .into_iter()
    .collect();
    ammonia::Builder::new()
        .tags(tags)
        .generic_attributes(HashSet::new())
        .url_schemes(HashSet::new())
        .link_rel(None)
        .clean(html)
        .to_string()
}

fn strip_xml(s: &str) -> String {
    esc(&crate::epub::decode_entities(&crate::epub::strip_tags(s, " ")))
}

fn render_field(t: u8, bytes: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(bytes).ok()?;
    match t {
        b'm' | b'l' | b'y' => Some(format!("<p>{}</p>", esc(s).replace('\n', "<br>"))),
        b't' => Some(format!("<p class=\"phon\">[{}]</p>", esc(s))),
        b'h' | b'g' => Some(sanitize_html(s)),
        b'x' => Some(format!("<p>{}</p>", strip_xml(s))),
        _ => None, // resource/binary/unknown field types are ignored, never rendered
    }
}

/// Decode one dictionary entry body into sanitized HTML.
pub fn decode_entry(data: &[u8], sts: &Option<String>) -> Result<String, String> {
    let mut out = String::new();
    let mut any = false;
    match sts {
        Some(seq) if !seq.is_empty() => {
            let ts = seq.as_bytes();
            let mut p = 0usize;
            for (k, &t) in ts.iter().enumerate() {
                let last = k == ts.len() - 1;
                let field: &[u8];
                if last {
                    field = &data[p.min(data.len())..];
                    p = data.len();
                } else if t.is_ascii_lowercase() {
                    let e = data[p..].iter().position(|&b| b == 0).ok_or("entry field unterminated")? + p;
                    field = &data[p..e];
                    p = e + 1;
                } else {
                    if p + 4 > data.len() { return Err("entry field truncated".into()); }
                    let n = u32::from_be_bytes(data[p..p + 4].try_into().unwrap()) as usize;
                    if p + 4 + n > data.len() { return Err("entry field truncated".into()); }
                    field = &data[p + 4..p + 4 + n];
                    p += 4 + n;
                }
                if let Some(h) = render_field(t.to_ascii_lowercase(), field) { out.push_str(&h); any = true; }
            }
        }
        _ => {
            let mut p = 0usize;
            while p < data.len() {
                let t = data[p];
                p += 1;
                let field: &[u8];
                if t.is_ascii_lowercase() {
                    let e = data[p..].iter().position(|&b| b == 0).map(|x| x + p).unwrap_or(data.len());
                    field = &data[p..e];
                    p = (e + 1).min(data.len());
                } else if t.is_ascii_uppercase() {
                    if p + 4 > data.len() { return Err("entry field truncated".into()); }
                    let n = u32::from_be_bytes(data[p..p + 4].try_into().unwrap()) as usize;
                    if p + 4 + n > data.len() { return Err("entry field truncated".into()); }
                    field = &data[p + 4..p + 4 + n];
                    p += 4 + n;
                } else {
                    return Err("unknown entry type byte".into());
                }
                if let Some(h) = render_field(t.to_ascii_lowercase(), field) { out.push_str(&h); any = true; }
            }
        }
    }
    if any { Ok(out) } else { Err("unsupported definition type".into()) }
}

pub fn normalize(s: &str) -> String {
    s.trim().nfkc().collect::<String>().to_lowercase()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Script { Latin, Han, Kana, Hangul, Other }

pub fn script_of(c: char) -> Script {
    match c as u32 {
        0x3040..=0x30ff | 0x31f0..=0x31ff | 0xff66..=0xff9f => Script::Kana,
        0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x2a6df => Script::Han,
        0xac00..=0xd7af | 0x1100..=0x11ff | 0x3130..=0x318f => Script::Hangul,
        _ if c.is_alphabetic() => Script::Latin,
        _ => Script::Other,
    }
}

/// Produces lookup candidates for a term, best first, with the characters each consumes and a confidence.
pub trait Tokenizer {
    fn candidates(&self, term: &str, context: &str) -> Vec<(String, usize, f32)>;
}

pub struct LatinTokenizer;
impl Tokenizer for LatinTokenizer {
    fn candidates(&self, term: &str, _ctx: &str) -> Vec<(String, usize, f32)> {
        let n = term.chars().count();
        let t = normalize(term);
        let mut v = vec![(t.clone(), n, 1.0f32)];
        let t2 = t.trim_end_matches(['\'', '\u{2019}']).trim_end_matches("'s").trim_end_matches("\u{2019}s").to_string();
        if t2 != t { v.push((t2.clone(), n, 0.9)); }
        let base = t2;
        let rules: [(&str, &str); 9] = [("ies", "y"), ("ied", "y"), ("ing", ""), ("ing", "e"), ("ed", ""), ("ed", "e"), ("es", ""), ("s", ""), ("ly", "")];
        for (suf, rep) in rules {
            if base.len() > suf.len() + 2 && base.ends_with(suf) {
                let stem = format!("{}{}", &base[..base.len() - suf.len()], rep);
                if rep.is_empty() {
                    let cs: Vec<char> = stem.chars().collect();
                    if cs.len() > 2 && cs[cs.len() - 1] == cs[cs.len() - 2] {
                        v.push((cs[..cs.len() - 1].iter().collect(), n, 0.6));
                    }
                }
                v.push((stem, n, 0.6));
            }
        }
        v
    }
}

pub struct CjkTokenizer { pub script: Script }
impl Tokenizer for CjkTokenizer {
    /// Tries the longest prefix of the following text first.
    fn candidates(&self, term: &str, ctx: &str) -> Vec<(String, usize, f32)> {
        let src = if ctx.is_empty() { term } else { ctx };
        let chars: Vec<char> = src.chars().take(12).collect();
        let mut v = Vec::new();
        for len in (1..=chars.len()).rev() {
            let s: String = chars[..len].iter().collect();
            v.push((normalize(&s), len, 0.5 + 0.5 * (len as f32 / chars.len().max(1) as f32)));
        }
        if self.script == Script::Hangul {
            const PARTICLES: [&str; 18] = ["에서", "으로", "에게", "까지", "부터", "처럼", "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "로"];
            let tok: String = src.chars().take_while(|c| script_of(*c) == Script::Hangul).collect();
            for p in PARTICLES {
                if let Some(stem) = tok.strip_suffix(p) {
                    if !stem.is_empty() { v.push((normalize(stem), stem.chars().count(), 0.7)); }
                }
            }
        }
        if self.script == Script::Kana || self.script == Script::Han {
            let tok: String = src.chars().take_while(|c| matches!(script_of(*c), Script::Han | Script::Kana)).collect();
            for end in ["ました", "ません", "ない", "ます", "ている", "った", "って", "んだ", "いた", "した", "て", "た", "い", "く", "る"] {
                if let Some(stem) = tok.strip_suffix(end) {
                    if !stem.is_empty() {
                        let stem_n = stem.chars().count();
                        v.push((normalize(&format!("{stem}る")), stem_n + end.chars().count(), 0.55));
                        v.push((normalize(stem), stem_n, 0.5));
                    }
                }
            }
        }
        v
    }
}

fn tokenizer_for(term: &str) -> (Box<dyn Tokenizer>, Script) {
    let s = term.chars().find(|c| script_of(*c) != Script::Other).map(script_of).unwrap_or(Script::Other);
    match s {
        Script::Han | Script::Kana | Script::Hangul => (Box::new(CjkTokenizer { script: s }), s),
        _ => (Box::new(LatinTokenizer), s),
    }
}

pub struct Lru {
    cap: usize,
    map: HashMap<(String, u64), String>,
    order: VecDeque<(String, u64)>,
}
impl Lru {
    pub fn new(cap: usize) -> Self { Lru { cap, map: HashMap::new(), order: VecDeque::new() } }
    pub fn get(&mut self, k: &(String, u64)) -> Option<String> {
        if let Some(v) = self.map.get(k) {
            let v = v.clone();
            self.order.retain(|x| x != k);
            self.order.push_back(k.clone());
            return Some(v);
        }
        None
    }
    pub fn put(&mut self, k: (String, u64), v: String) {
        if self.map.insert(k.clone(), v).is_none() {
            self.order.push_back(k);
            while self.order.len() > self.cap {
                if let Some(old) = self.order.pop_front() { self.map.remove(&old); }
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictInfo {
    pub dict_id: String,
    pub title: String,
    pub source_lang: Option<String>,
    pub target_lang: Option<String>,
    pub enabled: bool,
    pub priority: i64,
    pub entries: u64,
    pub attribution: String,
    pub imported_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<DictInfo>,
    pub errors: Vec<String>,
}

fn suffix_kind(name: &str) -> Option<(&str, &'static str)> {
    for (suf, kind) in [(".ifo", "ifo"), (".idx.gz", "idx"), (".idx", "idx"), (".dict.dz", "dict"), (".dict", "dict"), (".syn", "syn")] {
        if let Some(base) = name.strip_suffix(suf) { return Some((base, kind)); }
    }
    None
}

pub fn import(db: &Db, data_dir: &Path, picked: &[PathBuf]) -> ImportResult {
    let mut files: Vec<PathBuf> = Vec::new();
    for p in picked {
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(p) {
                files.extend(rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_file()));
            }
        } else {
            files.push(p.clone());
        }
    }
    let mut groups: HashMap<String, HashMap<&'static str, PathBuf>> = HashMap::new();
    let mut errors = Vec::new();
    for f in &files {
        let name = f.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        match suffix_kind(&name) {
            Some((base, kind)) => {
                let dir = f.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                groups.entry(format!("{dir}\u{0}{base}")).or_default().insert(kind, f.clone());
            }
            None => errors.push(format!("{name}: unsupported file type (expected .ifo, .idx[.gz], .dict[.dz], .syn)")),
        }
    }
    let mut imported = Vec::new();
    for (key, g) in groups {
        let base = key.split('\u{0}').nth(1).unwrap_or("dictionary").to_string();
        match import_one(db, data_dir, &g) {
            Ok(i) => imported.push(i),
            Err(e) => errors.push(format!("{base}: {e}")),
        }
    }
    ImportResult { imported, errors }
}

fn import_one(db: &Db, data_dir: &Path, g: &HashMap<&'static str, PathBuf>) -> Result<DictInfo, String> {
    let ifo_p = g.get("ifo").ok_or("missing .ifo file")?;
    let idx_p = g.get("idx").ok_or("missing .idx or .idx.gz file")?;
    let dict_p = g.get("dict").ok_or("missing .dict or .dict.dz file")?;
    let ifo_bytes = read_limited(ifo_p, MAX_IFO_BYTES)?;
    let ifo = parse_ifo(std::str::from_utf8(&ifo_bytes).map_err(|_| ".ifo is not UTF-8")?)?;

    let dict_is_dz = dict_p.to_string_lossy().ends_with(".dz");
    let dict_size = if dict_is_dz {
        DictZip::open(dict_p)?.uncompressed
    } else {
        std::fs::metadata(dict_p).map_err(|e| e.to_string())?.len()
    };
    if dict_size > MAX_DICT_BYTES { return Err("dictionary data is too large".into()); }

    let idx_data = read_limited(idx_p, MAX_IDX_BYTES)?;
    if ifo.idxfilesize != 0 && ifo.idxfilesize != idx_data.len() as u64 {
        return Err(format!("checksum mismatch: .ifo says idxfilesize={}, actual {}", ifo.idxfilesize, idx_data.len()));
    }
    let entries = parse_idx(&idx_data, ifo.idxoffsetbits, dict_size)?;
    if ifo.wordcount != 0 && ifo.wordcount != entries.len() as u64 {
        return Err(format!("checksum mismatch: .ifo says wordcount={}, found {}", ifo.wordcount, entries.len()));
    }
    let syns = match g.get("syn") {
        Some(p) => parse_syn(&read_limited(p, MAX_SYN_BYTES)?, entries.len())?,
        None => Vec::new(),
    };

    let mut h = Sha256::new();
    h.update(&ifo_bytes);
    h.update((idx_data.len() as u64).to_le_bytes());
    h.update(dict_size.to_le_bytes());
    let dict_id = hex::encode(&h.finalize()[..8]);

    // Stage in a temp dir so a failed import leaves nothing behind.
    let root = data_dir.join("dictionaries");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let final_dir = root.join(&dict_id);
    if final_dir.exists() { return Err("this dictionary is already imported".into()); }
    let stage = root.join(format!(".tmp-{dict_id}"));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let copy = |from: &Path, to: &str| std::fs::copy(from, stage.join(to)).map(|_| ()).map_err(|e| e.to_string());
    let res: Result<(), String> = (|| {
        copy(ifo_p, "dict.ifo")?;
        copy(idx_p, if idx_p.to_string_lossy().ends_with(".gz") { "dict.idx.gz" } else { "dict.idx" })?;
        copy(dict_p, if dict_is_dz { "dict.dict.dz" } else { "dict.dict" })?;
        if let Some(s) = g.get("syn") { copy(s, "dict.syn")?; }
        Ok(())
    })();
    if let Err(e) = res { let _ = std::fs::remove_dir_all(&stage); return Err(e); }

    let lang = guess_langs(&ifo);
    let imported_at = now_iso();
    let insert: Result<(), String> = (|| {
        let mut conn = db.lock()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO dictionaries(dict_id,title,path,source_lang,target_lang,enabled,priority,imported_at,metadata_json)
             VALUES (?1,?2,?3,?4,?5,1,(SELECT COALESCE(MAX(priority),0)+1 FROM dictionaries),?6,?7)",
            params![dict_id, ifo.bookname, format!("dictionaries/{dict_id}"), lang.0, lang.1, imported_at, serde_json::to_string(&ifo).unwrap_or_default()],
        ).map_err(|e| e.to_string())?;
        {
            let mut ins = tx.prepare("INSERT OR IGNORE INTO dictionary_entries(dict_id,term_normalized,target_offset,byte_size) VALUES (?1,?2,?3,?4)").map_err(|e| e.to_string())?;
            for e in entries.iter().filter(|e| e.size > 0) {
                ins.execute(params![dict_id, normalize(&e.word), e.offset as i64, e.size as i64]).map_err(|e| e.to_string())?;
            }
            for (w, i) in &syns {
                let e = &entries[*i];
                if e.size == 0 { continue; }
                ins.execute(params![dict_id, normalize(w), e.offset as i64, e.size as i64]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(e) = insert { let _ = std::fs::remove_dir_all(&stage); return Err(e); }
    if let Err(e) = std::fs::rename(&stage, &final_dir) {
        let _ = db.lock().map(|c| c.execute("DELETE FROM dictionaries WHERE dict_id=?1", params![dict_id]));
        let _ = std::fs::remove_dir_all(&stage);
        return Err(format!("could not finalize import: {e}"));
    }
    Ok(DictInfo {
        dict_id, title: ifo.bookname.clone(), source_lang: lang.0, target_lang: lang.1, enabled: true, priority: 0,
        entries: entries.len() as u64 + syns.len() as u64,
        attribution: attribution(&ifo), imported_at,
    })
}

fn attribution(i: &Ifo) -> String {
    [i.author.as_deref(), i.website.as_deref(), i.description.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

/// Guesses the language pair from the title and description.
fn guess_langs(i: &Ifo) -> (Option<String>, Option<String>) {
    let hay = format!("{} {}", i.bookname, i.description.clone().unwrap_or_default());
    let re = regex::Regex::new(r"(?i)\b([a-z]{2,3})\s*(?:-|_|→|->|to)\s*([a-z]{2,3})\b").unwrap();
    if let Some(c) = re.captures(&hay) {
        return (Some(c[1].to_lowercase()), Some(c[2].to_lowercase()));
    }
    (None, None)
}

pub fn list(db: &Db) -> Result<Vec<DictInfo>, String> {
    let c = db.open_reader()?;
    let mut st = c
        .prepare("SELECT d.dict_id,d.title,d.source_lang,d.target_lang,d.enabled,d.priority,d.imported_at,d.metadata_json,
                  (SELECT COUNT(*) FROM dictionary_entries e WHERE e.dict_id=d.dict_id) FROM dictionaries d ORDER BY d.priority,d.title")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            let meta: String = r.get(7)?;
            let ifo: Ifo = serde_json::from_str(&meta).unwrap_or_default();
            Ok(DictInfo {
                dict_id: r.get(0)?, title: r.get(1)?, source_lang: r.get(2)?, target_lang: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0, priority: r.get(5)?, imported_at: r.get(6)?,
                entries: r.get::<_, i64>(8)? as u64, attribution: attribution(&ifo),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn update(db: &Db, id: &str, enabled: Option<bool>, priority: Option<i64>, src: Option<String>, tgt: Option<String>) -> Result<(), String> {
    let c = db.lock()?;
    if let Some(e) = enabled { c.execute("UPDATE dictionaries SET enabled=?2 WHERE dict_id=?1", params![id, e as i64]).map_err(|e| e.to_string())?; }
    if let Some(p) = priority { c.execute("UPDATE dictionaries SET priority=?2 WHERE dict_id=?1", params![id, p]).map_err(|e| e.to_string())?; }
    if src.is_some() || tgt.is_some() {
        c.execute("UPDATE dictionaries SET source_lang=COALESCE(?2,source_lang), target_lang=COALESCE(?3,target_lang) WHERE dict_id=?1", params![id, src, tgt]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn remove(db: &Db, data_dir: &Path, id: &str) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_hexdigit()) || id.len() != 16 { return Err("invalid dictionary id".into()); }
    {
        let c = db.lock()?;
        c.execute("DELETE FROM dictionaries WHERE dict_id=?1", params![id]).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(data_dir.join("dictionaries").join(id));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupEntry {
    pub dict_id: String,
    pub dict_title: String,
    pub headword: String,
    pub html: String,
    pub confidence: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub found: bool,
    /// Characters of the input consumed by the match.
    pub matched_chars: usize,
    pub entries: Vec<LookupEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupArgs {
    pub term: String,
    /// Text starting at the hovered word.
    pub context: String,
    /// Book language code.
    pub book_lang: Option<String>,
    /// Restricts the lookup to these dictionaries, in order.
    pub dict_ids: Option<Vec<String>>,
}

pub fn lookup(db: &Db, data_dir: &Path, cache: &mut Lru, a: &LookupArgs) -> Result<LookupResult, String> {
    if a.term.chars().count() > 64 || a.context.chars().count() > 256 {
        return Err("lookup text too long".into());
    }
    let (tok, script) = tokenizer_for(&a.term);
    let cands = tok.candidates(&a.term, &a.context);
    let dicts: Vec<DictInfo> = list(db)?.into_iter().filter(|d| d.enabled).collect();
    let mut ordered: Vec<&DictInfo> = Vec::new();
    match &a.dict_ids {
        Some(ids) if !ids.is_empty() => {
            for id in ids { if let Some(d) = dicts.iter().find(|d| &d.dict_id == id) { ordered.push(d); } }
        }
        _ => {
            let want: Option<&str> = match script { Script::Han => Some("zh"), Script::Kana => Some("ja"), Script::Hangul => Some("ko"), _ => None };
            let book = a.book_lang.as_deref().map(|l| l.split(['-', '_']).next().unwrap_or("").to_lowercase());
            let mut v: Vec<&DictInfo> = dicts.iter().collect();
            v.sort_by_key(|d| {
                let l = d.source_lang.as_deref().unwrap_or("").to_lowercase();
                let hit = want.is_some_and(|w| l.starts_with(w) || (w == "zh" && l.starts_with("ja"))) || (want.is_none() && book.as_deref().is_some_and(|b| !b.is_empty() && l.starts_with(b)));
                (!hit, d.priority)
            });
            ordered = v;
        }
    }
    if ordered.is_empty() {
        return Ok(LookupResult { found: false, matched_chars: 0, entries: vec![] });
    }
    let c = db.open_reader()?;
    for (cand, consumed, conf) in &cands {
        if cand.is_empty() { continue; }
        let mut entries = Vec::new();
        for d in &ordered {
            let mut st = c
                .prepare("SELECT target_offset,byte_size FROM dictionary_entries WHERE dict_id=?1 AND term_normalized=?2 LIMIT 3")
                .map_err(|e| e.to_string())?;
            let rows: Vec<(i64, i64)> = st
                .query_map(params![d.dict_id, cand], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            if rows.is_empty() { continue; }
            let dir = data_dir.join("dictionaries").join(&d.dict_id);
            let ifo: Ifo = std::fs::read_to_string(dir.join("dict.ifo")).ok().and_then(|t| parse_ifo(&t).ok()).unwrap_or_default();
            let mut data = DictData::open(&dir)?;
            for (off, size) in rows {
                let key = (d.dict_id.clone(), off as u64);
                let html = match cache.get(&key) {
                    Some(h) => h,
                    None => {
                        let raw = data.read_at(off as u64, size as u32)?;
                        let h = decode_entry(&raw, &ifo.sametypesequence).unwrap_or_else(|_| "<p>(unsupported definition format)</p>".into());
                        cache.put(key, h.clone());
                        h
                    }
                };
                entries.push(LookupEntry { dict_id: d.dict_id.clone(), dict_title: d.title.clone(), headword: cand.clone(), html, confidence: *conf });
            }
        }
        if !entries.is_empty() {
            return Ok(LookupResult { found: true, matched_chars: *consumed, entries });
        }
    }
    Ok(LookupResult { found: false, matched_chars: 0, entries: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(words: &[(&str, u32, u32)]) -> Vec<u8> {
        let mut v = Vec::new();
        for (w, o, s) in words {
            v.extend_from_slice(w.as_bytes());
            v.push(0);
            v.extend_from_slice(&o.to_be_bytes());
            v.extend_from_slice(&s.to_be_bytes());
        }
        v
    }

    #[test]
    fn parses_ifo() {
        let t = "StarDict's dict ifo file\nversion=2.4.2\nbookname=Test en-fr\nwordcount=2\nidxfilesize=10\nsametypesequence=m\n";
        let i = parse_ifo(t).unwrap();
        assert_eq!(i.bookname, "Test en-fr");
        assert_eq!(i.idxoffsetbits, 32);
        assert!(parse_ifo("nope\nversion=2.4.2").is_err());
        assert!(parse_ifo("StarDict's dict ifo file\nversion=1.0\nbookname=x").is_err());
    }

    #[test]
    fn parses_idx_and_validates_bounds() {
        let d = idx(&[("cat", 0, 5), ("dog", 5, 5)]);
        let e = parse_idx(&d, 32, 10).unwrap();
        assert_eq!(e.len(), 2);
        assert_eq!(e[1].word, "dog");
        assert!(parse_idx(&d, 32, 9).is_err()); // dog points past data
        assert!(parse_idx(&d[..d.len() - 2], 32, 10).is_err()); // truncated
        assert!(parse_idx(&idx(&[("x", 0, u32::MAX)]), 32, u64::MAX).is_err()); // oversized entry
    }

    #[test]
    fn syn_index_checked() {
        let mut s = b"kitty\0".to_vec();
        s.extend_from_slice(&0u32.to_be_bytes());
        assert_eq!(parse_syn(&s, 1).unwrap()[0].1, 0);
        assert!(parse_syn(&s, 0).is_err());
    }

    #[test]
    fn decodes_and_sanitizes() {
        let html = decode_entry(b"<b>x</b><script>alert(1)</script><a href=\"http://e.com\">l</a><img src=\"http://e.com/i.png\">", &Some("h".into())).unwrap();
        assert!(html.contains("<b>x</b>"));
        assert!(!html.contains("script") && !html.contains("href") && !html.contains("img"));
        let m = decode_entry(b"a < b", &Some("m".into())).unwrap();
        assert_eq!(m, "<p>a &lt; b</p>");
        let mut d = b"mhello\0".to_vec();
        d.extend_from_slice(b"h<i>w</i>");
        assert!(decode_entry(&d, &None).unwrap().contains("<i>w</i>"));
    }

    #[test]
    fn cjk_longest_match_candidates() {
        let t = CjkTokenizer { script: Script::Han };
        let c = t.candidates("日", "日本語です");
        assert_eq!(c[0].1, 5);
        assert!(c.iter().any(|x| x.0 == "日本" && x.1 == 2));
    }

    #[test]
    fn latin_lemma() {
        let c = LatinTokenizer.candidates("Running", "");
        assert!(c.iter().any(|x| x.0 == "run") && c.iter().any(|x| x.0 == "running"));
        let c = LatinTokenizer.candidates("studies", "");
        assert!(c.iter().any(|x| x.0 == "study"));
    }

    #[test]
    fn lru_evicts() {
        let mut l = Lru::new(2);
        l.put(("a".into(), 1), "1".into());
        l.put(("a".into(), 2), "2".into());
        l.get(&("a".into(), 1));
        l.put(("a".into(), 3), "3".into());
        assert!(l.get(&("a".into(), 2)).is_none());
        assert!(l.get(&("a".into(), 1)).is_some());
    }
}
