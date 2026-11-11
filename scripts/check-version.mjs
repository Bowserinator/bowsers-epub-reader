// One source of truth: package.json. `--write` propagates it; default mode fails on any mismatch.
import { readFileSync, writeFileSync } from 'node:fs';
const write = process.argv.includes('--write');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const v = pkg.version;
const targets = [
  { file: 'src-tauri/Cargo.toml', re: /^(version\s*=\s*")([^"]+)(")/m },
  { file: 'src-tauri/tauri.conf.json', re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: 'packaging/io.github.bowsers.epubreader.metainfo.xml', re: /(<release version=")([^"]+)(")/ }
];
let bad = 0;
for (const t of targets) {
  const src = readFileSync(t.file, 'utf8');
  const m = src.match(t.re);
  if (!m) { console.error(`${t.file}: version field not found`); bad++; continue; }
  const cur = m[2];
  if (cur !== v) {
    if (write) { writeFileSync(t.file, src.replace(t.re, `$1${v}$3`)); console.log(`${t.file}: ${cur} -> ${v}`); }
    else { console.error(`${t.file}: version ${cur} != package.json ${v}`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(`versions in sync: ${v}`);
