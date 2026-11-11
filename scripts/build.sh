#!/usr/bin/env bash
# Local, CI-free build. Run on native Linux, or in Git Bash on Windows with the Windows Rust/Node
# toolchains (not WSL for Windows packages). Each OS builds its own packages.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
usage() { echo 'Usage: scripts/build.sh [auto|deb|rpm|appimage|flatpak|linux-all|windows|windows-portable]  (SKIP_CHECKS=1 to skip tests)'; }
case "${1:-auto}" in -h|--help) usage; exit 0;; esac
TARGET="${1:-auto}"
command -v pnpm >/dev/null || { echo 'pnpm is required' >&2; exit 1; }
command -v cargo >/dev/null || { echo 'Rust/Cargo is required' >&2; exit 1; }
OS="$(uname -s)"
if [[ "$TARGET" == auto ]]; then
  case "$OS" in
    Linux)
      . /etc/os-release
      family=" ${ID:-} ${ID_LIKE:-} "
      if [[ "$family" =~ (fedora|rhel|centos|suse) ]]; then TARGET=rpm
      elif [[ "$family" =~ (debian|ubuntu|linuxmint|pop) ]]; then TARGET=deb
      else echo 'Unknown Linux packaging family; specify deb, rpm or flatpak' >&2; exit 2; fi ;;
    MINGW*|MSYS*|CYGWIN*) TARGET=windows ;;
    *) echo 'Unsupported host: run on Windows (Git Bash) or Linux' >&2; exit 2 ;;
  esac
fi

if [[ -f pnpm-lock.yaml ]]; then pnpm install --frozen-lockfile
else echo 'WARNING: no pnpm-lock.yaml; installing unfrozen. Commit the generated lockfile for reproducible releases.' >&2; pnpm install; fi

if [[ "${SKIP_CHECKS:-0}" != 1 ]]; then
  node scripts/check-version.mjs
  for f in src-tauri/icons/icon.ico src-tauri/icons/128x128.png; do
    [[ -f "$f" ]] || { echo "Missing required file: $f" >&2; exit 1; }
  done
  pnpm test
  (cd src-tauri && cargo test --quiet && cargo clippy --quiet -- -D warnings)
fi

case "$TARGET" in
  windows|windows-portable)
    [[ "$OS" == MINGW* || "$OS" == MSYS* || "$OS" == CYGWIN* ]] || { echo 'Windows bundles require a native Windows toolchain (Git Bash on Windows)' >&2; exit 2; }
    if [[ "$TARGET" == windows ]]; then
      pnpm tauri build --bundles nsis
      echo 'NSIS output: src-tauri/target/release/bundle/nsis/'
    else
      pnpm tauri build --no-bundle
      mkdir -p release/windows-portable
      cp src-tauri/target/release/bowsers_epub_reader.exe release/windows-portable/
      cp LICENSE.md release/windows-portable/LICENSE.md
      cp packaging/windows/README-portable.txt release/windows-portable/README.txt
      echo 'Audit runtime DLL dependencies (dumpbin /DEPENDENTS) and the WebView2 prerequisite before distributing.'
    fi ;;
  deb|rpm)
    [[ "$OS" == Linux ]] || { echo 'Linux bundles require a Linux host' >&2; exit 2; }
    pnpm tauri build --bundles "$TARGET"
    echo "Output: src-tauri/target/release/bundle/$TARGET/" ;;
  appimage)
    [[ "$OS" == Linux ]] || { echo 'AppImage builds require a Linux host' >&2; exit 2; }
    NO_STRIP=true pnpm tauri build --bundles appimage
    echo 'Output: src-tauri/target/release/bundle/appimage/' ;;
  linux-all)
    [[ "$OS" == Linux ]] || { echo 'Linux bundles require a Linux host' >&2; exit 2; }
    pnpm tauri build --bundles deb,rpm
    SKIP_CHECKS=1 "$0" flatpak ;;
  flatpak)
    [[ "$OS" == Linux ]] || { echo 'Flatpak builds require Linux' >&2; exit 2; }
    command -v flatpak-builder >/dev/null || { echo 'Install flatpak-builder' >&2; exit 1; }
    command -v flatpak >/dev/null || { echo 'Install flatpak' >&2; exit 1; }
    pnpm tauri build --bundles deb
    mkdir -p release/flatpak build/flatpak-src
    shopt -s nullglob
    debs=(src-tauri/target/release/bundle/deb/*.deb)
    (( ${#debs[@]} == 1 )) || { echo "Expected exactly one .deb, got ${#debs[@]}" >&2; exit 1; }
    cp "${debs[0]}" build/flatpak-src/app.deb
    cp packaging/flatpak.yml build/flatpak-src/flatpak.yml
    cp packaging/io.github.bowsers.epubreader.metainfo.xml build/flatpak-src/
    cp src-tauri/icons/icon.png build/flatpak-src/
    flatpak-builder --force-clean --default-branch=stable --repo=release/flatpak/repo build/flatpak-root build/flatpak-src/flatpak.yml
    flatpak build-bundle release/flatpak/repo release/flatpak/bowsers-epub-reader.flatpak io.github.bowsers.epubreader stable ;;
  *) usage; echo "Unknown target: $TARGET" >&2; exit 2 ;;
esac
