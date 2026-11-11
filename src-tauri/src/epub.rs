//! EPUB validation, hashing and package parsing.

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

pub const MAX_BOOK_BYTES: u64 = 1 << 30; // 1 GiB
const MAX_ENTRIES: usize = 100_000;
const MAX_TOTAL_UNCOMPRESSED: u64 = 8 << 30;
const MAX_RATIO: u64 = 1000;
const MAX_CONTAINER_BYTES: u64 = 1 << 20;
const MAX_ENCRYPTION_BYTES: u64 = 4 << 20;
const MAX_OPF_BYTES: u64 = 16 << 20;
pub const MAX_SECTION_BYTES: u64 = 64 << 20;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    #[serde(skip)]
    pub path: PathBuf,
    pub book_id: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub fixed_layout: bool,
    pub direction: Option<String>,
}

/// Expands a leading `~` using the home directory.
pub fn expand_tilde(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
        if let Some(h) = home {
            let rest = s[1..].trim_start_matches(['/', '\\']);
            return PathBuf::from(h).join(rest);
        }
    }
    p.to_path_buf()
}

pub fn open_and_validate(path: &Path) -> Result<BookInfo, String> {
    let canon = path.canonicalize().map_err(|e| {
        format!("cannot open '{}': {}. Check that the file exists and is readable.", path.display(), e)
    })?;
    let meta = std::fs::metadata(&canon).map_err(|e| format!("cannot read '{}': {e}", canon.display()))?;
    if meta.is_dir() {
        return Err(format!("'{}' is a directory, not an EPUB file.", canon.display()));
    }
    if meta.len() == 0 {
        return Err(format!("'{}' is empty.", canon.display()));
    }
    if meta.len() > MAX_BOOK_BYTES {
        return Err(format!(
            "'{}' is {} MiB, which exceeds the {} MiB limit.",
            canon.display(),
            meta.len() >> 20,
            MAX_BOOK_BYTES >> 20
        ));
    }
    let book_id = hash_file(&canon).map_err(|e| format!("cannot read '{}': {e}", canon.display()))?;

    let file = File::open(&canon).map_err(|e| format!("cannot open '{}': {e}", canon.display()))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("'{}' is not a valid EPUB (ZIP error: {e}).", canon.display()))?;
    check_zip_limits(&mut zip)?;

    if let Ok(enc) = read_entry_string(&mut zip, "META-INF/encryption.xml", MAX_ENCRYPTION_BYTES) {
        if let Some(alg) = drm_algorithm(&enc) {
            return Err(format!(
                "this book is DRM-protected (encryption algorithm {alg}) and cannot be opened. DRM is not supported."
            ));
        }
    }
    if zip.by_name("META-INF/rights.xml").is_ok() {
        return Err("this book contains a rights.xml licence file (DRM) and cannot be opened.".into());
    }

    let pkg = read_package(&mut zip)?;
    if pkg.spine.is_empty() {
        return Err("invalid EPUB: the package document has an empty reading order (spine).".into());
    }

    let file_name = canon.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(BookInfo {
        path: canon,
        book_id,
        file_name,
        size_bytes: meta.len(),
        title: pkg.title,
        author: pkg.author,
        language: pkg.language,
        fixed_layout: pkg.fixed_layout,
        direction: pkg.direction,
    })
}

/// SHA-256 of the file as lowercase hex.
pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn check_zip_limits<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Result<(), String> {
    if zip.len() > MAX_ENTRIES {
        return Err(format!("rejected: archive has {} entries (limit {MAX_ENTRIES}).", zip.len()));
    }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let e = zip.by_index_raw(i).map_err(|e| format!("invalid EPUB: bad ZIP entry: {e}"))?;
        total = total.saturating_add(e.size());
        let comp = e.compressed_size().max(1);
        if e.size() > (50 << 20) && e.size() / comp > MAX_RATIO {
            return Err(format!("rejected: entry '{}' has a suspicious compression ratio (zip bomb).", e.name()));
        }
        if e.name().split(['/', '\\']).any(|c| c == "..") {
            return Err(format!("rejected: entry '{}' escapes the archive root.", e.name()));
        }
    }
    if total > MAX_TOTAL_UNCOMPRESSED {
        return Err("rejected: archive expands to an unreasonable size (zip bomb).".into());
    }
    Ok(())
}

pub fn read_entry_bytes<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let f = zip.by_name(name).map_err(|e| format!("{name}: {e}"))?;
    let mut out = Vec::new();
    f.take(limit + 1).read_to_end(&mut out).map_err(|e| format!("{name}: {e}"))?;
    if out.len() as u64 > limit {
        return Err(format!("{name}: larger than {limit} bytes"));
    }
    Ok(out)
}

pub fn read_entry_string<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<String, String> {
    let b = read_entry_bytes(zip, name, limit)?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

fn attr_re() -> Regex {
    Regex::new(r#"([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap()
}

pub fn parse_attrs(tag: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for c in attr_re().captures_iter(tag) {
        let v = c.get(2).or_else(|| c.get(3)).map(|x| x.as_str()).unwrap_or("");
        m.insert(c[1].to_string(), decode_entities(v));
    }
    m
}

pub fn read_package<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Result<Package, String> {
    let container = read_entry_string(zip, "META-INF/container.xml", MAX_CONTAINER_BYTES)
        .map_err(|e| format!("invalid EPUB: {e} (missing META-INF/container.xml)."))?;
    let opf_path = rootfile_path(&container).ok_or("invalid EPUB: container.xml has no rootfile.")?;
    let opf = read_entry_string(zip, &opf_path, MAX_OPF_BYTES)
        .map_err(|e| format!("invalid EPUB: package document '{opf_path}' unreadable: {e}"))?;
    Ok(parse_package(&opf, &opf_path))
}

fn rootfile_path(container: &str) -> Option<String> {
    let re = Regex::new(r"(?s)<rootfile\b[^>]*>").unwrap();
    for m in re.find_iter(container) {
        let a = parse_attrs(m.as_str());
        if let Some(p) = a.get("full-path") {
            return Some(p.clone());
        }
    }
    None
}

/// Returns the first encryption algorithm that is not font obfuscation.
fn drm_algorithm(enc: &str) -> Option<String> {
    const OK: [&str; 2] = ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];
    let re = Regex::new(r#"Algorithm\s*=\s*["']([^"']+)["']"#).unwrap();
    for c in re.captures_iter(enc) {
        let alg = &c[1];
        if !OK.contains(&alg) {
            return Some(alg.to_string());
        }
    }
    None
}

pub struct Package {
    pub title: Option<String>,
    pub author: Option<String>,
    pub language: Option<String>,
    pub fixed_layout: bool,
    pub direction: Option<String>,
    pub spine: Vec<String>,
}

pub fn parse_package(opf: &str, opf_path: &str) -> Package {
    let first = |tag: &str| -> Option<String> {
        let re = Regex::new(&format!(r"(?s)<(?:\w+:)?{tag}\b[^>]*>(.*?)</(?:\w+:)?{tag}>")).unwrap();
        re.captures(opf)
            .map(|c| decode_entities(strip_tags(&c[1], "").trim()))
            .filter(|s| !s.is_empty())
    };
    let base = opf_path.rsplit_once('/').map(|x| x.0).unwrap_or("");

    let mut manifest: HashMap<String, String> = HashMap::new();
    let item_re = Regex::new(r"(?s)<item\b[^>]*>").unwrap();
    for m in item_re.find_iter(opf) {
        let a = parse_attrs(m.as_str());
        if let (Some(id), Some(href)) = (a.get("id"), a.get("href")) {
            manifest.insert(id.clone(), resolve_path(base, href));
        }
    }
    let mut spine = Vec::new();
    let ir = Regex::new(r"(?s)<itemref\b[^>]*>").unwrap();
    for m in ir.find_iter(opf) {
        let a = parse_attrs(m.as_str());
        if let Some(idref) = a.get("idref") {
            if let Some(p) = manifest.get(idref) {
                spine.push(p.clone());
            }
        }
    }
    let direction = Regex::new(r"(?s)<spine\b[^>]*>")
        .unwrap()
        .find(opf)
        .and_then(|m| parse_attrs(m.as_str()).get("page-progression-direction").cloned())
        .filter(|d| d == "rtl" || d == "ltr");
    let fixed_layout = opf.contains("pre-paginated");
    Package {
        title: first("title"),
        author: first("creator"),
        language: first("language"),
        fixed_layout,
        direction,
        spine,
    }
}

/// Resolves `href` against `base` inside the archive, dropping any fragment.
pub fn resolve_path(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or("");
    let href = percent_decode(href);
    let mut parts: Vec<&str> = if href.starts_with('/') { Vec::new() } else { base.split('/').filter(|s| !s.is_empty()).collect() };
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| -> Option<u8> { (c as char).to_digit(16).map(|d| d as u8) };
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Removes markup tags, replacing each with `replacement`.
pub fn strip_tags(s: &str, replacement: &str) -> String {
    Regex::new(r"(?s)<[^>]*>").unwrap().replace_all(s, replacement).into_owned()
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let re = Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);").unwrap();
    re.replace_all(s, |c: &regex::Captures| {
        let e = &c[1];
        let named = match e {
            "amp" => Some("&"),
            "lt" => Some("<"),
            "gt" => Some(">"),
            "quot" => Some("\""),
            "apos" => Some("'"),
            "nbsp" => Some("\u{a0}"),
            "mdash" => Some("\u{2014}"),
            "ndash" => Some("\u{2013}"),
            "hellip" => Some("\u{2026}"),
            "lsquo" => Some("\u{2018}"),
            "rsquo" => Some("\u{2019}"),
            "ldquo" => Some("\u{201c}"),
            "rdquo" => Some("\u{201d}"),
            "copy" => Some("\u{a9}"),
            _ => None,
        };
        if let Some(n) = named {
            return n.to_string();
        }
        let cp = if let Some(h) = e.strip_prefix("#x") {
            u32::from_str_radix(h, 16).ok()
        } else if let Some(d) = e.strip_prefix('#') {
            d.parse::<u32>().ok()
        } else {
            None
        };
        cp.and_then(char::from_u32).map(|ch| ch.to_string()).unwrap_or_else(|| c[0].to_string())
    })
    .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths() {
        assert_eq!(resolve_path("OEBPS", "text/ch1.xhtml#a"), "OEBPS/text/ch1.xhtml");
        assert_eq!(resolve_path("OEBPS/text", "../img/a%20b.png"), "OEBPS/img/a b.png");
        assert_eq!(resolve_path("", "a.xhtml"), "a.xhtml");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("a &amp; b &#x41;&#66;"), "a & b AB");
        assert_eq!(decode_entities("&unknown;"), "&unknown;");
    }

    #[test]
    fn parses_package() {
        let opf = r#"<package><metadata><dc:title>Hi &amp; Bye</dc:title><dc:language>ja</dc:language></metadata>
            <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
            <spine page-progression-direction="rtl"><itemref idref="c1"/></spine></package>"#;
        let p = parse_package(opf, "OEBPS/content.opf");
        assert_eq!(p.title.as_deref(), Some("Hi & Bye"));
        assert_eq!(p.spine, vec!["OEBPS/ch1.xhtml"]);
        assert_eq!(p.direction.as_deref(), Some("rtl"));
    }

    #[test]
    fn detects_drm() {
        assert!(drm_algorithm(r#"<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>"#).is_some());
        assert!(drm_algorithm(r#"<EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>"#).is_none());
    }

    #[test]
    fn tilde() {
        std::env::set_var("HOME", "/home/x");
        assert_eq!(expand_tilde(Path::new("~/a b.epub")), PathBuf::from("/home/x/a b.epub"));
    }
}
