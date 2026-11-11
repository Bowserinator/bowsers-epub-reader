//! Attaches to the parent console on Windows so command-line output is visible.

#[cfg(windows)]
pub fn attach() {
    use std::os::windows::io::AsRawHandle;
    extern "system" {
        fn AttachConsole(pid: u32) -> i32;
        fn SetStdHandle(which: u32, handle: *mut core::ffi::c_void) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
            let h = f.as_raw_handle();
            SetStdHandle(STD_OUTPUT_HANDLE, h);
            SetStdHandle(STD_ERROR_HANDLE, h);
            std::mem::forget(f);
        }
    }
}

#[cfg(not(windows))]
pub fn attach() {}
