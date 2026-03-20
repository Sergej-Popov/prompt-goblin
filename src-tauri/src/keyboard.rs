use std::thread;
use std::time::Duration;

/// Type the full text at once into the currently focused window.
#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    send_text_native(&text)
}

/// Type a chunk of text incrementally (for beta incremental mode).
/// Optionally send backspaces first to erase previous partial text.
#[tauri::command]
pub fn type_text_incremental(text: String, backspaces: u32) -> Result<(), String> {
    // Send backspaces to erase previous partial text
    for _ in 0..backspaces {
        send_backspace_native()?;
    }
    // Small delay between erasing and typing
    if backspaces > 0 {
        thread::sleep(Duration::from_millis(10));
    }
    send_text_native(&text)
}

// ── Windows implementation ──────────────────────────────────────────

#[cfg(target_os = "windows")]
fn send_text_native(text: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };

    let mut inputs: Vec<INPUT> = Vec::new();

    for c in text.chars() {
        // Encode as UTF-16 (handles surrogate pairs for emoji etc.)
        let mut buf = [0u16; 2];
        let encoded = c.encode_utf16(&mut buf);

        for code_unit in encoded.iter().copied() {
            // Key down
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: code_unit,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            // Key up
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: code_unit,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }

    if inputs.is_empty() {
        return Ok(());
    }

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    if sent == 0 {
        Err("SendInput failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn send_backspace_native() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VK_BACK,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    if sent == 0 {
        Err("SendInput failed for backspace".to_string())
    } else {
        Ok(())
    }
}

// ── macOS implementation ────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos_cg {
    use std::ffi::c_void;
    use std::os::raw::c_ulong;

    pub type CGEventSourceRef = *mut c_void;
    pub type CGEventRef = *mut c_void;
    pub type CGKeyCode = u16;

    pub const K_CG_EVENT_SOURCE_STATE_HID: i32 = 1;
    pub const K_CG_HID_EVENT_TAP: u32 = 0;
    pub const K_VK_DELETE: CGKeyCode = 51;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGEventSourceCreate(state_id: i32) -> CGEventSourceRef;
        pub fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            virtual_key: CGKeyCode,
            key_down: bool,
        ) -> CGEventRef;
        pub fn CGEventKeyboardSetUnicodeString(
            event: CGEventRef,
            string_length: c_ulong,
            unicode_string: *const u16,
        );
        pub fn CGEventPost(tap: u32, event: CGEventRef);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFRelease(cf: *mut c_void);
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        pub static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    extern "C" {
        pub static kCFBooleanTrue: *const c_void;
        pub fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        pub static kCFTypeDictionaryKeyCallBacks: u8;
        pub static kCFTypeDictionaryValueCallBacks: u8;
    }

    /// Check if we have accessibility permission, prompting the user if not.
    pub unsafe fn ensure_accessibility() -> bool {
        if AXIsProcessTrusted() {
            return true;
        }
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &kCFTypeDictionaryKeyCallBacks as *const u8 as *const c_void,
            &kCFTypeDictionaryValueCallBacks as *const u8 as *const c_void,
        );
        let trusted = AXIsProcessTrustedWithOptions(options);
        if !options.is_null() {
            CFRelease(options as *mut c_void);
        }
        trusted
    }
}

#[cfg(target_os = "macos")]
fn send_text_native(text: &str) -> Result<(), String> {
    use macos_cg::*;
    use std::os::raw::c_ulong;

    unsafe {
        if !ensure_accessibility() {
            return Err(
                "Accessibility permission required. \
                 Grant access in System Settings > Privacy & Security > Accessibility, \
                 then restart the app."
                    .to_string(),
            );
        }

        let source = CGEventSourceCreate(K_CG_EVENT_SOURCE_STATE_HID);
        if source.is_null() {
            return Err("Failed to create CGEventSource".to_string());
        }

        let utf16: Vec<u16> = text.encode_utf16().collect();

        for chunk in utf16.chunks(20) {
            let key_down = CGEventCreateKeyboardEvent(source, 0, true);
            if !key_down.is_null() {
                CGEventKeyboardSetUnicodeString(
                    key_down,
                    chunk.len() as c_ulong,
                    chunk.as_ptr(),
                );
                CGEventPost(K_CG_HID_EVENT_TAP, key_down);
                CFRelease(key_down);
            }

            let key_up = CGEventCreateKeyboardEvent(source, 0, false);
            if !key_up.is_null() {
                CGEventKeyboardSetUnicodeString(
                    key_up,
                    chunk.len() as c_ulong,
                    chunk.as_ptr(),
                );
                CGEventPost(K_CG_HID_EVENT_TAP, key_up);
                CFRelease(key_up);
            }

            thread::sleep(Duration::from_millis(2));
        }

        CFRelease(source);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn send_backspace_native() -> Result<(), String> {
    use macos_cg::*;

    unsafe {
        if !ensure_accessibility() {
            return Err(
                "Accessibility permission required. \
                 Grant access in System Settings > Privacy & Security > Accessibility, \
                 then restart the app."
                    .to_string(),
            );
        }

        let source = CGEventSourceCreate(K_CG_EVENT_SOURCE_STATE_HID);
        if source.is_null() {
            return Err("Failed to create CGEventSource".to_string());
        }

        let key_down = CGEventCreateKeyboardEvent(source, K_VK_DELETE, true);
        if !key_down.is_null() {
            CGEventPost(K_CG_HID_EVENT_TAP, key_down);
            CFRelease(key_down);
        }

        let key_up = CGEventCreateKeyboardEvent(source, K_VK_DELETE, false);
        if !key_up.is_null() {
            CGEventPost(K_CG_HID_EVENT_TAP, key_up);
            CFRelease(key_up);
        }

        CFRelease(source);
    }

    Ok(())
}

// ── Stub for other platforms ────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn send_text_native(text: &str) -> Result<(), String> {
    let _ = text;
    Err("Keyboard simulation not implemented for this platform. \
         Contributions welcome: implement using xdotool (Linux)."
        .to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn send_backspace_native() -> Result<(), String> {
    Err("Keyboard simulation not implemented for this platform.".to_string())
}
