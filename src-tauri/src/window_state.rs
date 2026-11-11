//! Remembers where the main window was, and puts it back on the next launch.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Monitor, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

const FILE_NAME: &str = "window-state.json";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Screen {
    pub name: Option<String>,
    pub area: Rect,
}

/// Window position is its outer corner; its size is the inner (content) size.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct WindowState {
    pub window: Rect,
    pub screen: Option<Screen>,
    pub maximized: bool,
}

fn same_screen(a: &Screen, b: &Screen) -> bool {
    match (&a.name, &b.name) {
        (Some(x), Some(y)) => x == y,
        _ => a.area == b.area,
    }
}

fn clamp_axis(pos: i64, size: u32, origin: i32, extent: u32) -> i32 {
    let lo = i64::from(origin);
    let hi = lo + i64::from(extent) - i64::from(size);
    pos.clamp(lo, hi) as i32
}

/// Where the window should open: on its previous monitor if that still exists (keeping its place on it, even if
/// the monitors were rearranged), otherwise centered on the primary monitor.
pub fn restore_rect(saved: &WindowState, screens: &[Screen], primary: Option<&Screen>) -> Option<Rect> {
    let w = saved.window;
    let home = saved
        .screen
        .as_ref()
        .and_then(|old| screens.iter().find(|s| same_screen(s, old)).map(|s| (s, old)));
    if let Some((now, old)) = home {
        let width = w.width.min(now.area.width);
        let height = w.height.min(now.area.height);
        let x = i64::from(now.area.x) + i64::from(w.x) - i64::from(old.area.x);
        let y = i64::from(now.area.y) + i64::from(w.y) - i64::from(old.area.y);
        return Some(Rect {
            x: clamp_axis(x, width, now.area.x, now.area.width),
            y: clamp_axis(y, height, now.area.y, now.area.height),
            width,
            height,
        });
    }
    let a = primary.or_else(|| screens.first())?.area;
    let width = w.width.min(a.width);
    let height = w.height.min(a.height);
    Some(Rect {
        x: (i64::from(a.x) + (i64::from(a.width) - i64::from(width)) / 2) as i32,
        y: (i64::from(a.y) + (i64::from(a.height) - i64::from(height)) / 2) as i32,
        width,
        height,
    })
}

fn screen_of(m: &Monitor) -> Screen {
    let (p, s) = (m.position(), m.size());
    Screen {
        name: m.name().map(|n| n.to_string()),
        area: Rect { x: p.x, y: p.y, width: s.width, height: s.height },
    }
}

fn load(dir: &Path) -> Option<WindowState> {
    serde_json::from_slice(&std::fs::read(dir.join(FILE_NAME)).ok()?).ok()
}

fn store(dir: &Path, state: &WindowState) {
    if let Ok(bytes) = serde_json::to_vec(state) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join(FILE_NAME), bytes);
    }
}

/// The current geometry, or None while minimized or fullscreen. A maximized window keeps the size and position it
/// had before it was maximized.
fn capture(w: &WebviewWindow, previous: Option<&WindowState>) -> Option<WindowState> {
    if w.is_minimized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
        return None;
    }
    let maximized = w.is_maximized().unwrap_or(false);
    if let (true, Some(p)) = (maximized, previous) {
        return Some(WindowState { maximized: true, ..p.clone() });
    }
    let pos = w.outer_position().ok()?;
    let size = w.inner_size().ok()?;
    let screen = w.current_monitor().ok().flatten().as_ref().map(screen_of);
    Some(WindowState { window: Rect { x: pos.x, y: pos.y, width: size.width, height: size.height }, screen, maximized })
}

fn apply(w: &WebviewWindow, saved: &WindowState) {
    let screens: Vec<Screen> = w.available_monitors().unwrap_or_default().iter().map(screen_of).collect();
    let primary = w.primary_monitor().ok().flatten().as_ref().map(screen_of);
    let Some(r) = restore_rect(saved, &screens, primary.as_ref()) else { return };
    let _ = w.set_size(PhysicalSize::new(r.width, r.height));
    let _ = w.set_position(PhysicalPosition::new(r.x, r.y));
    if saved.maximized {
        let _ = w.maximize();
    }
}

fn update(w: &WebviewWindow, state: &Mutex<Option<WindowState>>) {
    let Ok(mut current) = state.lock() else { return };
    if let Some(s) = capture(w, current.as_ref()) {
        *current = Some(s);
    }
}

/// Restores the saved window geometry, shows the window, and saves its geometry when it closes.
pub fn restore_and_track(w: &WebviewWindow, data_dir: PathBuf) {
    let saved = load(&data_dir);
    if let Some(s) = &saved {
        apply(w, s);
    }
    let _ = w.show();
    let state = Arc::new(Mutex::new(saved));
    let win = w.clone();
    w.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => update(&win, &state),
        WindowEvent::CloseRequested { .. } => {
            update(&win, &state);
            if let Some(s) = state.lock().ok().and_then(|g| g.clone()) {
                store(&data_dir, &s);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(name: &str, x: i32, y: i32, width: u32, height: u32) -> Screen {
        Screen { name: Some(name.into()), area: Rect { x, y, width, height } }
    }

    fn state(on: Screen, window: Rect) -> WindowState {
        WindowState { window, screen: Some(on), maximized: false }
    }

    #[test]
    fn keeps_place_on_monitor_after_rearranging() {
        let saved = state(screen("DP-1", 1920, 0, 1920, 1080), Rect { x: 2020, y: 100, width: 800, height: 600 });
        let now = [screen("DP-1", 0, 0, 1920, 1080)];
        assert_eq!(restore_rect(&saved, &now, None), Some(Rect { x: 100, y: 100, width: 800, height: 600 }));
    }

    #[test]
    fn missing_monitor_centers_on_primary() {
        let saved = state(screen("HDMI-1", 3000, 0, 1920, 1080), Rect { x: 3100, y: 200, width: 1000, height: 700 });
        let now = [screen("DP-1", 0, 0, 1920, 1080)];
        assert_eq!(restore_rect(&saved, &now, Some(&now[0])), Some(Rect { x: 460, y: 190, width: 1000, height: 700 }));
    }

    #[test]
    fn oversized_window_is_shrunk_to_its_monitor() {
        let on = screen("DP-1", 0, 0, 1920, 1080);
        let saved = state(on.clone(), Rect { x: 0, y: 0, width: 3000, height: 2000 });
        assert_eq!(restore_rect(&saved, &[on], None), Some(Rect { x: 0, y: 0, width: 1920, height: 1080 }));
    }
}
