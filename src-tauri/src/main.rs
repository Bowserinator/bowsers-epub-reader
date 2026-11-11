// Hide the console window on Windows release builds.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use bowsers_epub_reader_lib::{console, epub, run};
use clap::Parser;
use std::path::PathBuf;
use std::process::exit;

#[derive(Parser)]
#[command(
    name = "bowsers_epub_reader",
    version,
    about = "Simple epub reader.",
    override_usage = "bowsers_epub_reader [OPTIONS] [BOOK.epub]",
    after_help = "Examples:\n  bowsers_epub_reader \"$HOME/Books/My Book.epub\"\n  bowsers_epub_reader /home/me/books/novel.epub\n  bowsers_epub_reader.exe \"C:\\Books\\novel.epub\"\n"
)]
struct Cli {
    /// EPUB file to open
    #[arg(value_name = "BOOK.epub")]
    book: Option<PathBuf>,
}

fn main() {
    console::attach();
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => e.exit(),
    };
    let Some(book) = cli.book else {
        run(None); // no argument: empty state with an Open book button
        return;
    };
    let path = epub::expand_tilde(&book);
    match epub::open_and_validate(&path) {
        Ok(info) => run(Some(info)),
        Err(msg) => {
            eprintln!("error: {msg}");
            exit(1);
        }
    }
}
