//! System font discovery.

use font_kit::source::SystemSource;
use std::collections::BTreeSet;

pub fn list_families() -> Vec<String> {
    let mut set = BTreeSet::new();
    if let Ok(fams) = SystemSource::new().all_families() {
        for f in fams {
            let f = f.trim().to_string();
            if !f.is_empty() && !f.starts_with('.') && !f.starts_with('@') {
                set.insert(f);
            }
        }
    }
    set.into_iter().collect()
}
